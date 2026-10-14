// Demo data for local development. Wipes every table first (unless run with
// --if-empty), so it is safe to re-run but must never point at a real database.
//
// Logins (password for all: "password123"):
//   alex@acme.test   — admin, team lead (Platform team)
//   sam@acme.test    — responder, Payments team (first on call)
//   jordan@acme.test — responder, Payments + Platform teams
//   riley@acme.test  — responder, engineering manager (last escalation step)
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
      TRUNCATE audit_log, api_keys, webhook_deliveries, webhook_endpoints, postmortems, notifications, timeline_events, incident_responders,
        incident_alerts, alerts, incidents, alert_rules, services, escalation_step_targets,
        escalation_steps, escalation_policies, team_members, teams, organization_members, users, organizations
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
      ["riley", "Riley Chen", "responder"],
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
    const payments = await team("Payments", [users.sam, users.jordan]);
    const platform = await team("Platform", [users.jordan, users.alex]);

    // Delays are minutes since the incident triggered. They're short so
    // escalation is visible in a demo; a real policy would use 5 / 10 / 15.
    type Target = { user?: number; team?: number };
    const policy = async (name: string, description: string, steps: { delay: number; targets: Target[] }[]) => {
      const { rows } = await db.query(
        `INSERT INTO escalation_policies (organization_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
        [org.id, name, description]
      );
      for (const [i, step] of steps.entries()) {
        const { rows: stepRows } = await db.query(
          `INSERT INTO escalation_steps (policy_id, position, delay_minutes) VALUES ($1, $2, $3) RETURNING id`,
          [rows[0].id, i + 1, step.delay]
        );
        for (const target of step.targets) {
          await db.query(
            `INSERT INTO escalation_step_targets (step_id, target_type, user_id, team_id) VALUES ($1, $2, $3, $4)`,
            [stepRows[0].id, target.user ? "user" : "team", target.user ?? null, target.team ?? null]
          );
        }
      }
      return rows[0].id as number;
    };
    const paymentsPolicy = await policy("Checkout escalation", "Payments team first, then the team lead, then engineering management", [
      { delay: 0, targets: [{ team: payments }] },
      { delay: 2, targets: [{ user: users.alex }] },
      { delay: 5, targets: [{ user: users.riley }] },
    ]);
    const platformPolicy = await policy("Platform on-call", "Platform engineer on call, then the team lead", [
      { delay: 0, targets: [{ user: users.jordan }] },
      { delay: 3, targets: [{ user: users.alex }] },
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
                              triggered_at, acknowledged_at, mitigated_at, resolved_at)
       VALUES ($1, 1, $2, 'Login latency above 3s', 'sev2', 'resolved', 'seed-auth-latency', $3, 1, 1,
               now() - interval '3 days', now() - interval '3 days' + interval '6 minutes',
               now() - interval '3 days' + interval '37 minutes',
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
      `INSERT INTO incident_responders (incident_id, user_id, role)
       VALUES ($1, $2, 'commander'), ($1, $3, 'responder'), ($1, $4, 'observer')`,
      [past.id, users.jordan, users.sam, users.alex]
    );
    const events: [string, number | null, string, number][] = [
      ["INCIDENT_CREATED", null, "Incident opened by alert from prometheus:auth-latency", 0],
      ["NOTIFICATION_SENT", null, "Paged Jordan Lee (escalation level 1)", 0],
      ["INCIDENT_ACKNOWLEDGED", users.jordan, "Acknowledged", 6],
      ["STATUS_CHANGED", users.jordan, "Investigation started", 9],
      ["NOTE_ADDED", users.jordan, "Connection pool to the session store saturated after a traffic spike", 21],
      ["NOTE_ADDED", users.jordan, "Raised pool size from 20 to 60 and restarted auth pods", 35],
      ["STATUS_CHANGED", users.jordan, "Mitigated — customer impact stopped: p95 back under 1s", 37],
      ["INCIDENT_RESOLVED", users.jordan, "Resolved: latency back under 400ms after pool resize", 48],
    ];
    for (const [type, actor, message, minutes] of events) {
      await db.query(
        `INSERT INTO timeline_events (incident_id, event_type, actor_id, message, created_at)
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
