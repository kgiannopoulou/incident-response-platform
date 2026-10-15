import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps";

// Incident-management metrics for the dashboard, over a window of the last
// 7, 30 or 90 days (with the window before it, for deltas):
//
//   GET /metrics?days=30
//   { window, summary, previous, bySeverity[], byService[], daily[], active[] }
//
// Definitions (incidents *triggered* in the window):
//   MTTA  mean(acknowledged_at − triggered_at) over incidents that were acknowledged
//   MTTR  mean(resolved_at − triggered_at)     over incidents that were resolved
// plus medians/p90 so one 9-hour outlier doesn't hide a good month. All
// computed in Postgres from the timestamps the state machine sets.

const querySchema = z.object({
  days: z.coerce
    .number()
    .refine((d) => [7, 30, 90].includes(d), "days must be 7, 30 or 90")
    .default(30),
});

// The same aggregate columns for every grouping, over incidents aliased `i`
// (count(i.id), so a LEFT JOIN without incidents counts 0).
const AGGREGATES = `
  count(i.id)::int AS incidents,
  count(i.id) FILTER (WHERE i.severity = 'sev1')::int AS sev1,
  count(i.id) FILTER (WHERE i.status <> 'resolved')::int AS still_open,
  count(i.id) FILTER (WHERE i.ack_timed_out_at IS NOT NULL)::int AS ack_timeouts,
  round(avg(extract(epoch FROM i.acknowledged_at - i.triggered_at)))::int AS mtta_seconds,
  round(avg(extract(epoch FROM i.resolved_at - i.triggered_at)))::int AS mttr_seconds,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.acknowledged_at - i.triggered_at)))::int AS tta_p50_seconds,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.resolved_at - i.triggered_at)))::int AS ttr_p50_seconds,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.resolved_at - i.triggered_at)))::int AS ttr_p90_seconds`;

const IN_WINDOW = `i.triggered_at > now() - make_interval(days => $2::int)`;

export function metricsRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    const { days } = querySchema.parse(req.query);
    const params = [req.user!.organizationId, days];

    const [summary, previous, bySeverity, byService, daily, active] = await Promise.all([
      deps.pool.query(`SELECT ${AGGREGATES} FROM incidents i WHERE i.organization_id = $1 AND ${IN_WINDOW}`, params),
      deps.pool.query(
        `SELECT ${AGGREGATES} FROM incidents i
         WHERE i.organization_id = $1 AND NOT (${IN_WINDOW})
           AND i.triggered_at > now() - make_interval(days => $2::int * 2)`,
        params
      ),
      deps.pool.query(
        `SELECT s.severity, ${AGGREGATES}
         FROM unnest(ARRAY['sev1', 'sev2', 'sev3', 'sev4']) AS s(severity)
         LEFT JOIN incidents i ON i.severity = s.severity AND i.organization_id = $1 AND ${IN_WINDOW}
         GROUP BY s.severity ORDER BY s.severity`,
        params
      ),
      deps.pool.query(
        `SELECT s.id, s.name, s.slug, s.status, ${AGGREGATES},
                (SELECT count(*)::int FROM incidents o WHERE o.service_id = s.id AND o.status <> 'resolved') AS open_incidents
         FROM services s
         LEFT JOIN incidents i ON i.service_id = s.id AND ${IN_WINDOW}
         WHERE s.organization_id = $1
         GROUP BY s.id ORDER BY count(i.id) DESC, s.name`,
        params
      ),
      // One row per UTC day in the window, zeros included, split by severity.
      deps.pool.query(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
                count(i.id) FILTER (WHERE i.severity = 'sev1')::int AS sev1,
                count(i.id) FILTER (WHERE i.severity = 'sev2')::int AS sev2,
                count(i.id) FILTER (WHERE i.severity = 'sev3')::int AS sev3,
                count(i.id) FILTER (WHERE i.severity = 'sev4')::int AS sev4
         FROM generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $2::int - 1),
                              date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') AS d(day)
         LEFT JOIN incidents i ON i.organization_id = $1 AND date_trunc('day', i.triggered_at AT TIME ZONE 'UTC') = d.day
         GROUP BY d.day ORDER BY d.day`,
        params
      ),
      // What's on fire right now: worst severity first, then oldest.
      deps.pool.query(
        `SELECT i.id, i.number, i.title, i.severity, i.status, i.triggered_at, i.acknowledged_at, i.alert_count,
                s.name AS service_name
         FROM incidents i LEFT JOIN services s ON s.id = i.service_id
         WHERE i.organization_id = $1 AND i.status <> 'resolved'
         ORDER BY i.severity, i.triggered_at
         LIMIT 20`,
        [req.user!.organizationId]
      ),
    ]);

    res.json({
      window: { days },
      summary: summary.rows[0],
      previous: previous.rows[0],
      bySeverity: bySeverity.rows,
      byService: byService.rows,
      daily: daily.rows,
      active: active.rows,
    });
  });

  return router;
}
