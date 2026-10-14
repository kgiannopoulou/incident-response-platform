// Helpers for integration tests (API + worker). They run against a real
// Postgres: a separate database, `<name>_test`, created on demand and reset
// before each test, so tests exercise the real SQL, constraints and locks.
import bcrypt from "bcryptjs";
import pg from "pg";
import { apiKeyDisplayPrefix, hashApiKey } from "@irp/shared/crypto";
import { createPool, databaseUrl, MIGRATIONS_DIR, runMigrations } from "./index";

export function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(databaseUrl());
  url.pathname = `/${url.pathname.slice(1)}_test`;
  return url.toString();
}

let migrated = false;

// Creates the test database if needed and applies migrations (once per process).
export async function setupTestDatabase() {
  const url = testDatabaseUrl();
  if (!migrated) {
    const name = new URL(url).pathname.slice(1);
    const adminUrl = new URL(url);
    adminUrl.pathname = "/postgres";
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (!rows[0]) await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
  }
  const pool = createPool(url);
  if (!migrated) {
    await runMigrations(pool, MIGRATIONS_DIR, () => {});
    migrated = true;
  }
  return pool;
}

export const TEST_PASSWORD = "test-password";
export const TEST_KEYS = {
  checkout: "ir_live_test_checkout",
  auth: "ir_live_test_auth",
  other: "ir_live_test_other_org",
};

export type Fixtures = Awaited<ReturnType<typeof resetFixtures>>;

// Wipes every table and inserts a small, known world:
//   org "acme": alex (admin), sam + jordan (responders), team Payments
//     (alex, sam), policy "Payments on-call": step 1 sam (0 min) -> step 2
//     alex (1 min) -> step 3 team Payments (2 min), minutes since trigger
//     services: checkout-api (policy, auto_resolve, "suppress staging" rule)
//               auth-service (no policy)
//   org "other": eve (admin), service other-api — for tenancy tests
//   Each service has one API key (TEST_KEYS), default rate limit.
let passwordHash: string | undefined;
export async function resetFixtures(pool: pg.Pool) {
  passwordHash ??= await bcrypt.hash(TEST_PASSWORD, 4);
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

  await pool.query(`
    TRUNCATE audit_log, api_keys, postmortems, notifications, timeline_events, incident_responders,
      incident_alerts, alerts, incidents, alert_rules, services, escalation_step_targets,
      escalation_steps, escalation_policies, team_members, teams, organization_members, users, organizations
    RESTART IDENTITY CASCADE
  `);

  const acme = await q(`INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme') RETURNING id`);
  const other = await q(`INSERT INTO organizations (name, slug) VALUES ('Other', 'other') RETURNING id`);

  const user = async (orgId: number, key: string, role: string) => {
    const row = await q(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [
      `${key}@test.dev`,
      key[0].toUpperCase() + key.slice(1),
      passwordHash,
    ]);
    await pool.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
      orgId,
      row.id,
      role,
    ]);
    return row.id as number;
  };
  const alex = await user(acme.id, "alex", "admin");
  const sam = await user(acme.id, "sam", "responder");
  const jordan = await user(acme.id, "jordan", "responder");
  const eve = await user(other.id, "eve", "admin");

  const team = await q(`INSERT INTO teams (organization_id, name) VALUES ($1, 'Payments') RETURNING id`, [acme.id]);
  await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)`, [team.id, alex, sam]);

  const policy = await q(
    `INSERT INTO escalation_policies (organization_id, name) VALUES ($1, 'Payments on-call') RETURNING id`,
    [acme.id]
  );
  for (const [position, delay, type, targetId] of [
    [1, 0, "user", sam],
    [2, 1, "user", alex],
    [3, 2, "team", team.id],
  ] as const) {
    const step = await q(
      `INSERT INTO escalation_steps (policy_id, position, delay_minutes) VALUES ($1, $2, $3) RETURNING id`,
      [policy.id, position, delay]
    );
    await pool.query(
      `INSERT INTO escalation_step_targets (step_id, target_type, user_id, team_id) VALUES ($1, $2, $3, $4)`,
      [step.id, type, type === "user" ? targetId : null, type === "team" ? targetId : null]
    );
  }

  const keyIds: Record<string, number> = {};
  const service = async (
    orgId: number,
    name: string,
    slug: string,
    key: keyof typeof TEST_KEYS,
    policyId: number | null,
    autoResolve: boolean
  ) => {
    const row = await q(
      `INSERT INTO services (organization_id, name, slug, escalation_policy_id, auto_resolve)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, name, slug, policyId, autoResolve]
    );
    const apiKey = await q(
      `INSERT INTO api_keys (organization_id, service_id, name, prefix, key_hash)
       VALUES ($1, $2, 'Test key', $3, $4) RETURNING id`,
      [orgId, row.id, apiKeyDisplayPrefix(TEST_KEYS[key]), hashApiKey(TEST_KEYS[key])]
    );
    keyIds[key] = apiKey.id;
    return row.id as number;
  };
  const checkout = await service(acme.id, "Checkout API", "checkout-api", "checkout", policy.id, true);
  const authService = await service(acme.id, "Auth Service", "auth-service", "auth", null, false);
  const otherService = await service(other.id, "Other API", "other-api", "other", null, false);

  await pool.query(
    `INSERT INTO alert_rules (service_id, position, name, conditions, action)
     VALUES ($1, 0, 'Ignore staging', '[{"field":"source","op":"contains","value":"staging"}]', 'suppress')`,
    [checkout]
  );

  return {
    orgs: { acme: acme.id as number, other: other.id as number },
    users: { alex, sam, jordan, eve },
    teamId: team.id as number,
    policyId: policy.id as number,
    services: { checkout, auth: authService, other: otherService },
    apiKeys: keyIds as Record<keyof typeof TEST_KEYS, number>,
  };
}
