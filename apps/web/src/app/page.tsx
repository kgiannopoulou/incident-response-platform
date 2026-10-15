"use client";

import Link from "next/link";
import { useState } from "react";
import { incidentRef, sevLabel, type IncidentSeverity } from "@irp/shared";
import { AlertFeed } from "@/components/alert-feed";
import { IncidentsChart, SEVERITY_FILL } from "@/components/dashboard/incidents-chart";
import { DeclareIncident } from "@/components/declare-incident";
import { Button, Card, cx, Empty, ErrorState, Loading, ServiceStatusPill, StatusBadge } from "@/components/ui";
import { duration } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useNow } from "@/lib/use-now";
import type { AlertRow, MetricAggregates, Metrics } from "@/lib/types";

// The home screen of an incident-response tool, top to bottom:
//
//   ACTIVE INCIDENTS            what's on fire now, worst first, live age
//   LAST 30 DAYS                incidents, SEV-1s, MTTA, MTTR (+ change vs the window before)
//   per day / per service       where and when incidents happen
//   by severity                 MTTA / MTTR per severity
//   SERVICE HEALTH · ALERTS
//
// Everything comes from GET /metrics?days= and refreshes on live events.

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const SEV_DOT: Record<IncidentSeverity, string> = { sev1: "🔴", sev2: "🟠", sev3: "🟡", sev4: "🔵" };

// "14m", "2h 5m", "3d" — the age of an open incident.
function age(iso: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

// Change against the previous window. For durations lower is better; the
// arrow and the words carry the meaning, the color only reinforces it.
function Delta({ now, before, lowerIsBetter, days }: { now: number | null; before: number | null; lowerIsBetter?: boolean; days: number }) {
  if (now === null || before === null || before === 0) return <p className="mt-1 text-xs text-zinc-500">no data for the previous {days} days</p>;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <p className="mt-1 text-xs text-zinc-500">same as the previous {days} days</p>;
  const better = lowerIsBetter ? pct < 0 : undefined;
  return (
    <p className={cx("mt-1 text-xs", better === undefined ? "text-zinc-400" : better ? "text-emerald-400" : "text-red-300")}>
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct)}% vs previous {days} days{better === undefined ? "" : better ? " (better)" : " (worse)"}
    </p>
  );
}

function Kpi({ label, value, hint, children }: { label: string; value: string | number; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3" title={hint}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-zinc-100">{value}</div>
      {children}
    </div>
  );
}

function Kpis({ s, p, days }: { s: MetricAggregates; p: MetricAggregates; days: Range }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Incidents" value={s.incidents}>
        <Delta now={s.incidents} before={p.incidents} days={days} />
      </Kpi>
      <Kpi label="SEV-1" value={s.sev1}>
        <Delta now={s.sev1} before={p.sev1} days={days} />
      </Kpi>
      <Kpi label="Mean acknowledge" value={duration(s.mtta_seconds)} hint="MTTA: mean time from trigger to acknowledgement">
        <Delta now={s.mtta_seconds} before={p.mtta_seconds} lowerIsBetter days={days} />
      </Kpi>
      <Kpi label="Mean resolution" value={duration(s.mttr_seconds)} hint="MTTR: mean time from trigger to resolution">
        <Delta now={s.mttr_seconds} before={p.mttr_seconds} lowerIsBetter days={days} />
      </Kpi>
    </div>
  );
}

export default function DashboardPage() {
  const [declaring, setDeclaring] = useState(false);
  const [days, setDays] = useState<Range>(30);
  const now = useNow(15_000);
  const metrics = useApi<Metrics>(`/metrics?days=${days}`, (e) => e.type.startsWith("incident.") || e.type === "service.updated");
  const alerts = useApi<{ alerts: AlertRow[] }>("/alerts", (e) => e.type === "alert.received" || e.type === "incident.updated");

  const m = metrics.data;
  const maxPerService = Math.max(1, ...(m?.byService.map((s) => s.incidents) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Incident response</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="danger" onClick={() => setDeclaring(true)}>
            Declare incident
          </Button>
        </div>
      </div>

      {metrics.error && <ErrorState message={metrics.error} onRetry={metrics.reload} />}
      {!m && !metrics.error && <Loading />}

      {m && (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card
              title={
                <span className="flex items-center gap-2">
                  Active incidents
                  <span className={cx("rounded-full px-2 text-xs tabular-nums", m.active.length ? "bg-red-500/20 text-red-200" : "bg-zinc-800 text-zinc-400")}>
                    {m.active.length}
                  </span>
                </span>
              }
              className="lg:col-span-2"
              actions={
                <Link href="/incidents" className="text-xs text-zinc-400 hover:underline">
                  All incidents →
                </Link>
              }
            >
              {m.active.length === 0 ? (
                <Empty>All clear — no open incidents.</Empty>
              ) : (
                <ul className="divide-y divide-zinc-800">
                  {m.active.map((i) => (
                    <li key={i.id}>
                      <Link href={`/incidents/${i.number}`} className="flex items-center gap-3 py-2 text-sm hover:bg-zinc-800/40">
                        <span aria-hidden>{SEV_DOT[i.severity]}</span>
                        <span className="w-12 shrink-0 font-semibold text-zinc-300">{sevLabel(i.severity)}</span>
                        <span className="min-w-0 flex-1 truncate text-zinc-100">
                          <span className="mr-2 font-mono text-xs text-zinc-500">{incidentRef(i.number)}</span>
                          {i.title}
                          {i.service_name && <span className="text-zinc-500"> · {i.service_name}</span>}
                        </span>
                        <StatusBadge status={i.status} />
                        <span className="w-14 shrink-0 text-right font-mono tabular-nums text-zinc-300" title={`Opened ${i.triggered_at}`}>
                          {age(i.triggered_at, now)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Service health"
              actions={
                <Link href="/services" className="text-xs text-zinc-400 hover:underline">
                  Manage →
                </Link>
              }
            >
              <ul className="divide-y divide-zinc-800">
                {[...m.byService]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((svc) => (
                    <li key={svc.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="text-zinc-200">{svc.name}</span>
                      <span className="flex items-center gap-3">
                        {svc.open_incidents > 0 && <span className="text-xs text-zinc-500">{svc.open_incidents} open</span>}
                        <ServiceStatusPill status={svc.status} />
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-zinc-800 pt-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Last {days} days</h2>
            <div className="inline-flex rounded-md border border-zinc-700 p-0.5 text-xs" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setDays(r)}
                  aria-pressed={days === r}
                  className={cx("rounded px-2.5 py-1", days === r ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-300 hover:bg-zinc-800")}
                >
                  {r}d
                </button>
              ))}
            </div>
          </div>

          <Kpis s={m.summary} p={m.previous} days={days} />

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Incidents per day" className="lg:col-span-2">
              <IncidentsChart daily={m.daily} />
            </Card>
            <Card title="Incidents per service">
              <ul className="space-y-3">
                {m.byService.map((svc) => (
                  <li key={svc.id} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-200">{svc.name}</span>
                      <span className="tabular-nums text-zinc-300">{svc.incidents}</span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-zinc-800">
                      <div className="h-2 rounded-full bg-zinc-300" style={{ width: `${(svc.incidents / maxPerService) * 100}%` }} />
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {svc.sev1 > 0 && `${svc.sev1} SEV-1 · `}MTTR {duration(svc.mttr_seconds)}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card title="By severity">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm tabular-nums">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2 text-left font-medium">Severity</th>
                    <th className="pb-2 font-medium">Incidents</th>
                    <th className="pb-2 font-medium" title="Mean time to acknowledge">MTTA</th>
                    <th className="pb-2 font-medium" title="Median time to acknowledge">Median ack</th>
                    <th className="pb-2 font-medium" title="Mean time to resolve">MTTR</th>
                    <th className="pb-2 font-medium" title="90th percentile time to resolve">p90 resolve</th>
                    <th className="pb-2 font-medium">Missed ack timeouts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 text-zinc-200">
                  {m.bySeverity.map((s) => (
                    <tr key={s.severity}>
                      <td className="py-2 text-left">
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: SEVERITY_FILL[s.severity] }} />
                        {sevLabel(s.severity)}
                      </td>
                      <td>{s.incidents}</td>
                      <td>{duration(s.mtta_seconds)}</td>
                      <td>{duration(s.tta_p50_seconds)}</td>
                      <td>{duration(s.mttr_seconds)}</td>
                      <td>{duration(s.ttr_p90_seconds)}</td>
                      <td className={s.ack_timeouts ? "text-red-300" : undefined}>{s.ack_timeouts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Card
        title="Alerts"
        actions={
          <Link href="/alerts" className="text-xs text-zinc-400 hover:underline">
            All alerts →
          </Link>
        }
      >
        {alerts.error ? (
          <ErrorState message={alerts.error} onRetry={alerts.reload} />
        ) : alerts.loading ? (
          <Loading />
        ) : (
          <AlertFeed alerts={alerts.data!.alerts} limit={12} />
        )}
      </Card>

      {declaring && <DeclareIncident onClose={() => setDeclaring(false)} />}
    </div>
  );
}
