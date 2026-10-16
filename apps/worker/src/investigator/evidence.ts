import type { Pool } from "pg";
import {
  evidenceItem,
  redact,
  type AlertEvidence,
  type DeploymentEvidence,
  type EvidenceBundle,
  type EvidenceItem,
  type IncidentBrief,
  type LogGroupEvidence,
  type LogLevel,
  type RelatedIncidentEvidence,
  type TimelineEvidence,
} from "@irp/shared";

// The investigator's read-only view of one organization's telemetry, around
// one incident. Every query is scoped to the incident's organization — the
// agent can pass any service name or time range, but can never see another
// tenant's data. Every item returned is recorded in the ledger, which is what
// the findings' citations are validated against.

const MIN = 60_000;
const LOOKBACK_MINUTES = 120;
const MAX_WINDOW_HOURS = 24;
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];
const clean = (text: string | null | undefined, max = 300) => {
  const t = redact(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export type TimeRange = { from?: string | null; to?: string | null };

export class EvidenceStore {
  readonly ledger = new Map<string, EvidenceItem>();

  private constructor(
    private pool: Pool,
    readonly organizationId: number,
    readonly incidentId: number,
    readonly brief: IncidentBrief,
    readonly window: { from: string; to: string }
  ) {}

  static async open(pool: Pool, incidentId: number) {
    const { rows } = await pool.query(
      `SELECT i.organization_id, i.number, i.title, i.severity, i.status, i.triggered_at, i.acknowledged_at, i.resolved_at,
              s.slug, s.name,
              (SELECT min(a.received_at) FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id WHERE ia.incident_id = i.id) AS first_alert_at
       FROM incidents i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1`,
      [incidentId]
    );
    const r = rows[0];
    if (!r) return null;
    const brief: IncidentBrief = {
      number: r.number,
      title: clean(r.title, 200),
      severity: r.severity,
      status: r.status,
      service: r.slug,
      serviceName: r.name,
      triggeredAt: iso(r.triggered_at)!,
      acknowledgedAt: iso(r.acknowledged_at),
      resolvedAt: iso(r.resolved_at),
      firstAlertAt: iso(r.first_alert_at),
    };
    const start = new Date(Math.min(Date.parse(brief.firstAlertAt ?? brief.triggeredAt), Date.parse(brief.triggeredAt)));
    const end = brief.resolvedAt ? new Date(brief.resolvedAt) : new Date();
    const window = {
      from: new Date(start.getTime() - LOOKBACK_MINUTES * MIN).toISOString(),
      to: new Date(Math.min(end.getTime() + 5 * MIN, start.getTime() + MAX_WINDOW_HOURS * 60 * MIN)).toISOString(),
    };
    const store = new EvidenceStore(pool, r.organization_id, incidentId, brief, window);
    if (brief.service) store.ledger.set(`service:${brief.service}`, { id: `service:${brief.service}`, kind: "service", at: null, service: brief.service, summary: brief.serviceName ?? brief.service });
    return store;
  }

  // A range from the caller (the agent), clamped: at most 24 h wide, never in
  // the future, defaulting to the incident's window.
  private range({ from, to }: TimeRange = {}) {
    const f = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date(this.window.from);
    let t = to && !Number.isNaN(Date.parse(to)) ? new Date(to) : new Date(this.window.to);
    if (t.getTime() > Date.now()) t = new Date();
    if (t.getTime() - f.getTime() > MAX_WINDOW_HOURS * 60 * MIN) t = new Date(f.getTime() + MAX_WINDOW_HOURS * 60 * MIN);
    if (t <= f) t = new Date(f.getTime() + MIN);
    return { from: f, to: t };
  }

  private record<T>(items: T[], toItem: (x: T) => EvidenceItem) {
    for (const x of items) {
      const item = toItem(x);
      this.ledger.set(item.id, item);
    }
    return items;
  }

  async dependencies(service = this.brief.service) {
    if (!service) return { upstream: [], downstream: [] };
    const { rows } = await this.pool.query<{ direction: string; slug: string; name: string }>(
      `SELECT 'upstream' AS direction, up.slug, up.name
         FROM service_dependencies d JOIN services s ON s.id = d.service_id JOIN services up ON up.id = d.depends_on_service_id
         WHERE s.organization_id = $1 AND s.slug = $2
       UNION ALL
       SELECT 'downstream', down.slug, down.name
         FROM service_dependencies d JOIN services s ON s.id = d.depends_on_service_id JOIN services down ON down.id = d.service_id
         WHERE s.organization_id = $1 AND s.slug = $2
       ORDER BY 1, 2`,
      [this.organizationId, service]
    );
    for (const r of rows) this.ledger.set(`service:${r.slug}`, { id: `service:${r.slug}`, kind: "service", at: null, service: r.slug, summary: r.name });
    return {
      upstream: rows.filter((r) => r.direction === "upstream").map((r) => r.slug),
      downstream: rows.filter((r) => r.direction === "downstream").map((r) => r.slug),
    };
  }

  // Alerts grouped by service + title: first/last time, count, worst severity.
  async alerts(options: TimeRange & { service?: string | null } = {}): Promise<AlertEvidence[]> {
    const { from, to } = this.range(options);
    const { rows } = await this.pool.query(
      `SELECT s.slug, a.title, count(*)::int AS count, min(a.received_at) AS first_at, max(a.received_at) AS last_at,
              (array_agg(a.public_id ORDER BY a.received_at))[1] AS first_id,
              (array_agg(a.severity ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END))[1] AS severity,
              (array_agg(i.number ORDER BY a.received_at) FILTER (WHERE i.number IS NOT NULL))[1] AS incident
       FROM alerts a JOIN services s ON s.id = a.service_id
       LEFT JOIN incident_alerts ia ON ia.alert_id = a.id LEFT JOIN incidents i ON i.id = ia.incident_id
       WHERE a.organization_id = $1 AND a.received_at BETWEEN $2 AND $3 AND ($4::text IS NULL OR s.slug = $4)
       GROUP BY s.slug, a.title ORDER BY min(a.received_at) LIMIT 50`,
      [this.organizationId, from, to, options.service ?? null]
    );
    return this.record(
      rows.map((r) => ({
        id: `alert:${r.first_id}`,
        service: r.slug,
        at: iso(r.first_at)!,
        lastAt: iso(r.last_at)!,
        severity: r.severity,
        title: clean(r.title, 200),
        count: r.count,
        incident: r.incident ?? null,
      })),
      evidenceItem.alert
    );
  }

  async deployments(options: TimeRange & { service?: string | null } = {}): Promise<DeploymentEvidence[]> {
    const { from, to } = this.range(options);
    const { rows } = await this.pool.query(
      `SELECT d.id, s.slug, d.version, d.kind, d.status, d.description, d.author, d.commit_sha, d.started_at, d.finished_at,
              (SELECT p.version FROM deployments p WHERE p.service_id = d.service_id AND p.started_at < d.started_at
                 AND p.status = 'succeeded' ORDER BY p.started_at DESC LIMIT 1) AS previous_version
       FROM deployments d JOIN services s ON s.id = d.service_id
       WHERE d.organization_id = $1 AND d.started_at BETWEEN $2 AND $3 AND ($4::text IS NULL OR s.slug = $4)
       ORDER BY d.started_at LIMIT 30`,
      [this.organizationId, from, to, options.service ?? null]
    );
    return this.record(
      rows.map((r) => ({
        id: `deploy:${r.id}`,
        service: r.slug,
        version: clean(r.version, 100),
        kind: r.kind,
        status: r.status,
        description: clean(r.description, 400),
        author: r.author ? clean(r.author, 80) : null,
        commitSha: r.commit_sha,
        startedAt: iso(r.started_at)!,
        finishedAt: iso(r.finished_at),
        previousVersion: r.previous_version ? clean(r.previous_version, 100) : null,
      })),
      evidenceItem.deployment
    );
  }

  // Log patterns (same fingerprint) in the range, most frequent first, each
  // compared with an equally long baseline window just before it.
  async logs(options: TimeRange & { service?: string | null; minLevel?: LogLevel | null; query?: string | null } = {}): Promise<LogGroupEvidence[]> {
    const { from, to } = this.range(options);
    const baselineFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
    const levels = LEVELS.slice(LEVELS.indexOf(options.minLevel ?? "warn"));
    const query = options.query?.trim() ? `%${options.query.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await this.pool.query(
      `SELECT s.slug, l.fingerprint, count(*)::int AS count, min(l.ts) AS first_at, max(l.ts) AS last_at,
              (array_agg(l.id ORDER BY l.ts))[1] AS first_id,
              (array_agg(l.message ORDER BY l.ts))[1] AS sample,
              (array_agg(l.level ORDER BY CASE l.level WHEN 'fatal' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 WHEN 'info' THEN 3 ELSE 4 END))[1] AS level,
              (SELECT count(*)::int FROM log_events b
                 WHERE b.service_id = l.service_id AND b.fingerprint = l.fingerprint AND b.ts >= $5 AND b.ts < $2) AS baseline
       FROM log_events l JOIN services s ON s.id = l.service_id
       WHERE l.organization_id = $1 AND l.ts BETWEEN $2 AND $3 AND l.level = ANY($4)
         AND ($6::text IS NULL OR s.slug = $6) AND ($7::text IS NULL OR l.message ILIKE $7)
       GROUP BY s.slug, l.service_id, l.fingerprint ORDER BY count(*) DESC LIMIT 25`,
      [this.organizationId, from, to, levels, baselineFrom, options.service ?? null, query]
    );
    return this.record(
      rows
        .map((r) => ({
          id: `log:${r.first_id}`,
          service: r.slug,
          level: r.level as LogLevel,
          sample: clean(r.sample, 240),
          count: r.count,
          firstAt: iso(r.first_at)!,
          lastAt: iso(r.last_at)!,
          baselineCount: r.baseline,
          isNew: r.baseline === 0,
        }))
        .sort((a, b) => a.firstAt.localeCompare(b.firstAt)),
      evidenceItem.log
    );
  }

  // Other incidents of the organization open at some point in the range.
  async relatedIncidents(options: TimeRange = {}): Promise<RelatedIncidentEvidence[]> {
    const { from, to } = this.range(options);
    const { rows } = await this.pool.query(
      `SELECT i.number, s.slug, i.title, i.severity, i.status, i.triggered_at
       FROM incidents i LEFT JOIN services s ON s.id = i.service_id
       WHERE i.organization_id = $1 AND i.id <> $2 AND i.triggered_at <= $4 AND (i.resolved_at IS NULL OR i.resolved_at >= $3)
       ORDER BY i.triggered_at LIMIT 20`,
      [this.organizationId, this.incidentId, from, to]
    );
    return this.record(
      rows.map((r) => ({
        id: `incident:INC-${r.number}`,
        number: r.number,
        service: r.slug,
        title: clean(r.title, 200),
        severity: r.severity,
        status: r.status,
        triggeredAt: iso(r.triggered_at)!,
      })),
      evidenceItem.incident
    );
  }

  async timeline(): Promise<TimelineEvidence[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.created_at, t.event_type, t.message, u.name AS actor
       FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_id
       WHERE t.incident_id = $1 ORDER BY t.id LIMIT 200`,
      [this.incidentId]
    );
    return this.record(
      rows.map((r) => ({ id: `event:${r.id}`, at: iso(r.created_at)!, type: r.event_type, message: clean(r.message, 300), actor: r.actor })),
      evidenceItem.event
    );
  }

  // Everything at once, for the offline investigator: the incident's
  // service and its dependencies, over the default window.
  async bundle(): Promise<EvidenceBundle> {
    const dependencies = await this.dependencies();
    return {
      incident: this.brief,
      window: this.window,
      dependencies,
      alerts: await this.alerts(),
      deployments: await this.deployments(),
      logGroups: await this.logs({ minLevel: "warn" }),
      relatedIncidents: await this.relatedIncidents(),
      timeline: await this.timeline(),
    };
  }
}
