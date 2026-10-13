// Demo data for local development. Wipes every table first (unless run with
// --if-empty), so it is safe to re-run but must never point at a real database.
//
// Logins (password for all: "password123"):
//   alex@acme.test   — admin, Payments team
//   sam@acme.test    — responder, Payments team (first on call)
//   jordan@acme.test — responder, Platform team
//
// Service slugs and API keys (send alerts with `Authorization: Bearer <key>`):
//   checkout-api       ir_live_dev_checkout_api
//   auth-service       ir_live_dev_auth_service
//   postgres-primary   ir_live_dev_postgres_primary
//   iot-gateway        ir_live_dev_iot_gateway
import bcrypt from "bcryptjs";
import { ulid } from "@irp/shared";
import { apiKeyDisplayPrefix, hashApiKey } from "@irp/shared/crypto";
import { createPool, withTransaction } from "./index";

const pool = createPool();

async function main() {
  // `--if-empty` (used by the Docker setup) never wipes existing data.
  if (process.argv.includes("--if-empty")) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM organizations`);
    if (rows[0].n > 0) {
      console.log("Database already has data; skipping seed.");
      return;
    }
  }
  await withTransaction(pool, async (db) => {
    await db.query(`
      TRUNCATE audit_log, api_keys, postmortems, notifications, timeline_events, incident_responders,
        incident_alerts, alerts, incidents, alert_rules, services, escalation_rules,
        escalation_policies, team_members, teams, organization_members, users, organizations
      RESTART IDENTITY CASCADE
    `);

    const {
      rows: [org],
    } = await db.query(
      `INSERT INTO organizations (name, slug) VALUES ('Acme Shop', 'acme') RETURNING id`
    );

    const passwordHash = await bcrypt.hash("password123", 10);
    const users: Record<string, number> = {};
    for (const [key, name, role] of [
      ["alex", "Alex Morgan", "admin"],
      ["sam", "Sam Rivera", "responder"],
      ["jordan", "Jordan Lee", "responder"],
    ] as const) {
      const { rows } = await db.query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [`${key}@acme.test`, name, passwordHash]
      );
      users[key] = rows[0].id;
      await db.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`,
        [org.id, rows[0].id, role]
      );
    }

    const team = async (name: string, members: number[]) => {
      const { rows } = await db.query(
        `INSERT INTO teams (organization_id, name) VALUES ($1, $2) RETURNING id`,
        [org.id, name]
      );
      for (const userId of members) {
        await db.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [rows[0].id, userId]);
      }
      return rows[0].id as number;
    };
    const payments = await team("Payments", [users.alex, users.sam]);
    const platform = await team("Platform", [users.jordan, users.alex]);

    // Short delays so escalation is visible in a demo.
    const policy = async (name: string, levels: { delay: number; user?: number; team?: number }[]) => {
      const { rows } = await db.query(
        `INSERT INTO escalation_policies (organization_id, name) VALUES ($1, $2) RETURNING id`,
        [org.id, name]
      );
      for (const [i, level] of levels.entries()) {
        await db.query(
          `INSERT INTO escalation_rules (policy_id, level, delay_minutes, target_user_id, target_team_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [rows[0].id, i + 1, level.delay, level.user ?? null, level.team ?? null]
        );
      }
      return rows[0].id as number;
    };
    const paymentsPolicy = await policy("Payments on-call", [
      { delay: 0, user: users.sam },
      { delay: 2, user: users.alex },
      { delay: 5, team: payments },
    ]);
    const platformPolicy = await policy("Platform on-call", [
      { delay: 0, user: users.jordan },
      { delay: 3, user: users.alex },
    ]);

    // Each service gets one API key. Real keys are random (generateApiKey);
    // these fixed dev keys just make the README examples copy-pasteable.
    const service = async (
      name: string,
      slug: string,
      description: string,
      teamId: number,
      policyId: number,
      key: string,
      autoResolve = false
    ) => {
      const { rows } = await db.query(
        `INSERT INTO services (organization_id, team_id, escalation_policy_id, name, slug, description, auto_resolve)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [org.id, teamId, policyId, name, slug, description, autoResolve]
      );
      await db.query(
        `INSERT INTO api_keys (organization_id, service_id, name, prefix, key_hash, created_by)
         VALUES ($1, $2, 'Prometheus', $3, $4, $5)`,
        [org.id, rows[0].id, apiKeyDisplayPrefix(key), hashApiKey(key), users.alex]
      );
      return rows[0].id as number;
    };
    const checkout = await service(
      "Checkout API",
      "checkout-api",
      "Cart, payment and order placement",
      payments,
      paymentsPolicy,
      "ir_live_dev_checkout_api",
      true
    );
    const auth = await service(
      "Authentication Service",
      "auth-service",
      "Login, sessions and tokens",
      platform,
      platformPolicy,
      "ir_live_dev_auth_service"
    );
    await service("PostgreSQL Primary", "postgres-primary", "Primary OLTP database", platform, platformPolicy, "ir_live_dev_postgres_primary");
    await service("IoT Gateway", "iot-gateway", "MQTT ingestion from store sensors", platform, platformPolicy, "ir_live_dev_iot_gateway");

    // Matching rules for the checkout service, to show rule evaluation.
    await db.query(
      `INSERT INTO alert_rules (service_id, position, name, conditions, action, incident_severity) VALUES
       ($1, 0, 'Ignore staging probes', '[{"field":"source","op":"contains","value":"staging"}]', 'suppress', NULL),
       ($1, 1, 'Page on payment latency warnings',
        '[{"field":"title","op":"contains","value":"latency"},{"field":"severity","op":"at_least","value":"warning"}]',
        'create_incident', 'sev3')`,
      [checkout]
    );

    // One historical, already-resolved incident so the dashboard isn't empty.
    const {
      rows: [past],
    } = await db.query(
      `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, dedup_key,
                              commander_id, escalation_level, alert_count,
                              triggered_at, acknowledged_at, resolved_at)
       VALUES ($1, 1, $2, 'Login latency above 3s', 'sev2', 'resolved', 'seed-auth-latency', $3, 1, 1,
               now() - interval '3 days', now() - interval '3 days' + interval '6 minutes',
               now() - interval '3 days' + interval '48 minutes')
       RETURNING id, triggered_at`,
      [org.id, auth, users.jordan]
    );
    const {
      rows: [pastAlert],
    } = await db.query(
      `INSERT INTO alerts (organization_id, service_id, public_id, dedup_key, title, description, severity,
                           source, status, received_at, resolved_at)
       VALUES ($1, $2, $4, 'seed-auth-latency', 'Login p95 latency 3400ms', 'p95 above the 3s SLO for 5 minutes',
               'high', 'prometheus:auth-latency', 'resolved', $3, $3::timestamptz + interval '47 minutes')
       RETURNING id`,
      [org.id, auth, past.triggered_at, `alert_${ulid(new Date(past.triggered_at).getTime())}`]
    );
    await db.query(`UPDATE organizations SET incident_counter = 1 WHERE id = $1`, [org.id]);
    await db.query(`INSERT INTO incident_alerts (incident_id, alert_id) VALUES ($1, $2)`, [past.id, pastAlert.id]);
    await db.query(
      `INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1, $2, 'commander')`,
      [past.id, users.jordan]
    );
    const events: [string, number | null, string, number][] = [
      ["incident_created", null, "Incident opened by alert from prometheus:auth-latency", 0],
      ["notified", null, "Paged Jordan Lee (escalation level 1)", 0],
      ["acknowledged", users.jordan, "Acknowledged", 6],
      ["status_changed", users.jordan, "Status changed to investigating", 9],
      ["note", users.jordan, "Connection pool to the session store saturated after a traffic spike", 21],
      ["note", users.jordan, "Raised pool size from 20 to 60 and restarted auth pods", 35],
      ["resolved", users.jordan, "Resolved: latency back under 400ms after pool resize", 48],
    ];
    for (const [type, actor, message, minutes] of events) {
      await db.query(
        `INSERT INTO timeline_events (incident_id, type, actor_user_id, message, created_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz + make_interval(mins => $6))`,
        [past.id, type, actor, message, past.triggered_at, minutes]
      );
    }
  });
  console.log("Seeded demo organization 'acme' (log in as alex@acme.test / password123).");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
