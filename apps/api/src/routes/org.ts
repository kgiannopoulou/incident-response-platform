import { Router } from "express";
import type { Deps } from "../deps";
import { isStreamId } from "@irp/shared/realtime";
import { requireAdmin } from "../lib/auth";

// Read-only organization data: people, teams, the audit trail and response
// metrics for the dashboard.
export function orgRouter(deps: Deps) {
  const router = Router();

  router.get("/users", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT u.id, u.name, u.email, m.role FROM users u
       JOIN organization_members m ON m.user_id = u.id
       WHERE m.organization_id = $1 ORDER BY u.name`,
      [req.user!.organizationId]
    );
    res.json({ users: rows });
  });

  router.get("/teams", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT t.id, t.name,
              COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                       FILTER (WHERE u.id IS NOT NULL), '[]') AS members
       FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       LEFT JOIN users u ON u.id = tm.user_id
       WHERE t.organization_id = $1
       GROUP BY t.id ORDER BY t.name`,
      [req.user!.organizationId]
    );
    res.json({ teams: rows });
  });

  // Keyset pagination (`before` = last id seen) so the log stays fast as it grows.
  router.get("/audit-log", requireAdmin, async (req, res) => {
    const before = req.query.before ? Number(req.query.before) : null;
    const { rows } = await deps.pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.organization_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
       ORDER BY a.id DESC LIMIT 50`,
      [req.user!.organizationId, before]
    );
    res.json({ entries: rows, nextBefore: rows.length === 50 ? rows[rows.length - 1].id : null });
  });

  // MTTA / MTTR over the last 30 days plus what's open right now.
  router.get("/stats", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT
         count(*) FILTER (WHERE status <> 'resolved')::int AS open_incidents,
         count(*) FILTER (WHERE status = 'triggered')::int AS unacknowledged,
         count(*) FILTER (WHERE triggered_at > now() - interval '30 days')::int AS incidents_30d,
         round(avg(extract(epoch FROM acknowledged_at - triggered_at))
               FILTER (WHERE triggered_at > now() - interval '30 days'))::int AS mtta_seconds,
         round(avg(extract(epoch FROM resolved_at - triggered_at))
               FILTER (WHERE triggered_at > now() - interval '30 days'))::int AS mttr_seconds
       FROM incidents WHERE organization_id = $1`,
      [req.user!.organizationId]
    );
    res.json({ stats: rows[0] });
  });

  // Live updates. EventSource sends the session cookie, so the same auth
  // middleware applies; the hub writes every event for this organization.
  // On reconnect the browser sends Last-Event-ID (or, for a brand-new
  // EventSource after a hard failure, ?lastEventId=) and the hub replays
  // what was missed first.
  router.get("/stream", async (req, res) => {
    const requested = req.get("last-event-id") ?? req.query.lastEventId;
    const lastEventId = isStreamId(requested) ? requested : null;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    await deps.hub.add(req.user!.organizationId, res, lastEventId);
  });

  return router;
}
