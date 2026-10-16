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
import { DEMO_DEPENDENCIES, ulid } from "@irp/shared";
import { apiKeyDisplayPrefix, hashApiKey } from "@irp/shared/crypto";
import { createPool, withTransaction } from "./index";
import { incidentHistory } from "./seed-history";

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

    // Delays are minutes since the incident triggered. The checkout policy
    // is the plan's 0 / 5 / 10, plus a 2-minute acknowledgement timeout for
    // SEV1/SEV2 so the fast lane is visible in a demo.
    type Target = { user?: number; team?: number };
    const policy = async (
      name: string,
      description: string,
      ackTimeoutMinutes: number | null,
      steps: { delay: number; targets: Target[] }[]
    ) => {
      const { rows } = await db.query(
        `INSERT INTO escalation_policies (organization_id, name, description, ack_timeout_minutes)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [org.id, name, description, ackTimeoutMinutes]
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
    const paymentsPolicy = await policy("Checkout escalation", "Payments team first, then the team lead, then engineering management", 2, [
      { delay: 0, targets: [{ team: payments }] },
      { delay: 5, targets: [{ user: users.alex }] },
      { delay: 10, targets: [{ user: users.riley }] },
    ]);
    const platformPolicy = await policy("Platform on-call", "Platform engineer on call, then the team lead", null, [
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
    const postgres = await service("PostgreSQL Primary", "postgres-primary", "Primary OLTP database", platform, platformPolicy, "ir_live_dev_postgres_primary");
    const iot = await service("IoT Gateway", "iot-gateway", "MQTT ingestion from store sensors", platform, platformPolicy, "ir_live_dev_iot_gateway");

    // Who calls whom: the incident investigator looks upstream along these.
    const serviceBySlug: Record<string, number> = { "checkout-api": checkout, "auth-service": auth, "postgres-primary": postgres, "iot-gateway": iot };
    for (const [from, to] of DEMO_DEPENDENCIES) {
      await db.query(`INSERT INTO service_dependencies (service_id, depends_on_service_id) VALUES ($1, $2)`, [serviceBySlug[from], serviceBySlug[to]]);
    }

    // Matching rules for the checkout service, to show rule evaluation.
    await db.query(
      `INSERT INTO alert_rules (service_id, position, name, conditions, action, incident_severity) VALUES
       ($1, 0, 'Ignore staging probes', '[{"field":"source","op":"contains","value":"staging"}]', 'suppress', NULL),
       ($1, 1, 'Page on payment latency warnings',
        '[{"field":"title","op":"contains","value":"latency"},{"field":"severity","op":"at_least","value":"warning"}]',
        'create_incident', 'sev3')`,
      [checkout]
    );

    // Sixty days of resolved incidents (seed-history.ts), numbered in the
    // order they happened, each with its alert, commander and a timeline
    // through to resolution — so the dashboard metrics and incident pages
    // have history on a fresh install.
    const serviceIds = { checkout, auth, postgres, iot };
    const history = incidentHistory();
    const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
    for (const [i, h] of history.entries()) {
      const triggeredAt = new Date(Date.now() - h.minutesAgo * 60_000);
      const commander = users[h.commander];
      const {
        rows: [incident],
      } = await db.query(
        `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, dedup_key, commander_id,
                                escalation_level, alert_count, triggered_at, acknowledged_at, mitigated_at, resolved_at,
                                ack_timed_out_at)
         VALUES ($1, $2, $3, $4, $5, 'resolved', $6, $7, $8, 1, $9, $10, $11, $12, $13) RETURNING id`,
        [
          org.id,
          i + 1,
          serviceIds[h.service],
          h.title,
          h.severity,
          `seed-history-${i + 1}`,
          commander,
          h.ackTimedOut ? 2 : 1,
          triggeredAt,
          at(triggeredAt, h.ackAfter),
          h.mitigateAfter === null ? at(triggeredAt, h.resolveAfter) : at(triggeredAt, h.mitigateAfter),
          at(triggeredAt, h.resolveAfter),
          h.ackTimedOut ? at(triggeredAt, 2) : null,
        ]
      );
      const {
        rows: [alert],
      } = await db.query(
        `INSERT INTO alerts (organization_id, service_id, public_id, dedup_key, title, severity, source, status, received_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'resolved', $8, $9) RETURNING id`,
        [
          org.id,
          serviceIds[h.service],
          `alert_${ulid(triggeredAt.getTime())}`,
          `seed-history-${i + 1}`,
          h.alert.title,
          h.alert.severity,
          h.alert.source,
          triggeredAt,
          at(triggeredAt, h.resolveAfter),
        ]
      );
      await db.query(`INSERT INTO incident_alerts (incident_id, alert_id) VALUES ($1, $2)`, [incident.id, alert.id]);
      await db.query(`INSERT INTO incident_responders (incident_id, user_id, role, joined_at) VALUES ($1, $2, 'commander', $3)`, [
        incident.id,
        commander,
        at(triggeredAt, h.ackAfter),
      ]);
      const events: [string, number | null, string, number][] = [
        ["INCIDENT_CREATED", null, `Incident opened by alert from ${h.alert.source}`, 0],
        ["NOTIFICATION_SENT", null, "Paged the on-call responder (escalation level 1)", 0],
        ...(h.ackTimedOut
          ? ([
              ["ACK_TIMEOUT", null, "Not acknowledged within 2 minutes — escalated early", 2],
              ["INCIDENT_ESCALATED", null, "Escalated to level 2", 2],
            ] as [string, null, string, number][])
          : []),
        ["INCIDENT_ACKNOWLEDGED", commander, "Acknowledged", h.ackAfter],
        ["NOTE_ADDED", commander, h.notes[0].message, h.notes[0].after],
        ["NOTE_ADDED", commander, h.notes[1].message, h.notes[1].after],
        ...(h.mitigateAfter !== null
          ? ([["STATUS_CHANGED", commander, "Mitigated — customer impact stopped", h.mitigateAfter]] as [string, number, string, number][])
          : []),
        ["INCIDENT_RESOLVED", commander, `Resolved: ${h.notes[1].message.toLowerCase()}`, h.resolveAfter],
      ];
      for (const [type, actor, message, minutes] of events.sort((a, b) => a[3] - b[3])) {
        await db.query(`INSERT INTO timeline_events (incident_id, event_type, actor_id, message, created_at) VALUES ($1, $2, $3, $4, $5)`, [
          incident.id,
          type,
          actor,
          message,
          at(triggeredAt, minutes),
        ]);
      }
    }
    await db.query(`UPDATE organizations SET incident_counter = $2 WHERE id = $1`, [org.id, history.length]);
  });
  console.log("Seeded demo organization 'acme' (log in as alex@acme.test / password123).");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
