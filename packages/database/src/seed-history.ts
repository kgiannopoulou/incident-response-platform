// Sixty days of believable, already-resolved incidents for the demo, so the
// dashboard's 7/30/90-day metrics (MTTA, MTTR, incidents per service and
// severity, the daily chart) have something to show on a fresh install.
// A seeded PRNG keeps every `npm run db:seed` identical.

export type ServiceKey = "checkout" | "auth" | "postgres" | "iot";
export type ResponderKey = "sam" | "jordan" | "alex" | "riley";

export type HistoricalIncident = {
  service: ServiceKey;
  title: string;
  severity: "sev1" | "sev2" | "sev3" | "sev4";
  alert: { title: string; source: string; severity: "critical" | "high" | "warning" | "info" };
  minutesAgo: number; // when it triggered
  ackAfter: number; // minutes after trigger
  mitigateAfter: number | null;
  resolveAfter: number;
  commander: ResponderKey;
  ackTimedOut: boolean;
  notes: { after: number; message: string }[];
};

// mulberry32: tiny deterministic PRNG.
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATALOG: Record<ServiceKey, { title: string; alert: string; source: string; note: string; fix: string }[]> = {
  checkout: [
    { title: "Checkout error rate elevated", alert: "Checkout 5xx rate above 5%", source: "prometheus", note: "Errors started right after the 14:00 deploy", fix: "Rolled back the deploy" },
    { title: "Payment provider timeouts", alert: "Card processor p99 above 8s", source: "datadog", note: "Provider status page confirms degraded EU region", fix: "Failed over to the secondary processor" },
    { title: "Checkout API latency elevated", alert: "Checkout p95 latency 2400ms", source: "prometheus", note: "Connection pool saturated during the promo campaign", fix: "Raised the pool size and added a replica" },
  ],
  auth: [
    { title: "Login failures spiking", alert: "Login failure ratio above 20%", source: "grafana", note: "Expired signing certificate on one auth node", fix: "Rotated the certificate and restarted the node" },
    { title: "Session store latency", alert: "Redis session p99 above 500ms", source: "prometheus", note: "Memory pressure evicting session keys", fix: "Scaled the session store" },
  ],
  postgres: [
    { title: "Replication lag on primary", alert: "Replica lag above 30s", source: "pg-exporter", note: "Long-running analytics query holding locks", fix: "Killed the query and moved analytics to the replica" },
    { title: "Disk usage above 85%", alert: "Postgres data volume 87% full", source: "node-exporter", note: "WAL archiving stalled after credential rotation", fix: "Fixed archiver credentials; WAL drained" },
  ],
  iot: [
    { title: "Sensor ingestion backlog", alert: "MQTT consumer lag above 50k messages", source: "kafka-exporter", note: "One consumer pod crash-looping on a malformed payload", fix: "Deployed a parser fix and replayed the backlog" },
    { title: "Store gateways offline", alert: "12 store gateways missed heartbeats", source: "iot-probe", note: "ISP outage affecting stores in one region", fix: "Connectivity restored by the ISP; gateways reconnected" },
  ],
};

const TEAM: Record<ServiceKey, ResponderKey[]> = {
  checkout: ["sam", "jordan"],
  auth: ["jordan", "alex"],
  postgres: ["jordan", "alex"],
  iot: ["jordan", "riley"],
};

const ALERT_SEVERITY = { sev1: "critical", sev2: "high", sev3: "warning", sev4: "info" } as const;

export function incidentHistory(seed = 20261015): HistoricalIncident[] {
  const rand = prng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const between = (min: number, max: number) => min + rand() * (max - min);
  const incidents: HistoricalIncident[] = [];

  // Previous 30 days: noisier and slower (26 incidents); last 30 days: the
  // team improved (37 incidents, faster acknowledgement) — so the dashboard's
  // deltas tell a story.
  for (const [count, fromDays, toDays, slow] of [
    [26, 60, 30, 1.5],
    [37, 30, 0.2, 1],
  ] as const) {
    for (let n = 0; n < count; n++) {
      const service = pick(["checkout", "checkout", "checkout", "auth", "auth", "postgres", "iot", "iot"] as const);
      const entry = pick(CATALOG[service]);
      const r = rand();
      const severity = r < 0.07 ? "sev1" : r < 0.38 ? "sev2" : r < 0.8 ? "sev3" : "sev4";
      const urgent = severity === "sev1" || severity === "sev2";
      const ackTimedOut = urgent && rand() < 0.12 * slow;
      const ackAfter = ackTimedOut ? between(2.5, 9) : between(0.4, urgent ? 4 : 12) * slow;
      const resolveAfter = ackAfter + between(urgent ? 10 : 8, urgent ? 45 : 80) * slow;
      const mitigateAfter = rand() < 0.6 ? ackAfter + (resolveAfter - ackAfter) * between(0.35, 0.75) : null;
      incidents.push({
        service,
        title: entry.title,
        severity,
        alert: { title: entry.alert, source: entry.source, severity: ALERT_SEVERITY[severity] },
        minutesAgo: Math.round(between(toDays, fromDays) * 24 * 60),
        ackAfter: Math.round(ackAfter * 10) / 10,
        mitigateAfter: mitigateAfter === null ? null : Math.round(mitigateAfter * 10) / 10,
        resolveAfter: Math.round(resolveAfter * 10) / 10,
        commander: pick(TEAM[service]),
        ackTimedOut,
        notes: [
          { after: ackAfter + (resolveAfter - ackAfter) * 0.3, message: entry.note },
          { after: ackAfter + (resolveAfter - ackAfter) * 0.8, message: entry.fix },
        ],
      });
    }
  }
  return incidents.sort((a, b) => b.minutesAgo - a.minutesAgo); // oldest first
}
