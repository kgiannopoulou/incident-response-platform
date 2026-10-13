"use client";

import Link from "next/link";
import { useState } from "react";
import { incidentRef } from "@irp/shared";
import { DeclareIncident } from "@/components/declare-incident";
import { IncidentTable } from "@/components/incident-table";
import { Button, Card, cx, Empty, ErrorState, Loading, ServiceStatusPill } from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { AlertRow, IncidentSummary, Service } from "@/lib/types";

type Stats = {
  open_incidents: number;
  unacknowledged: number;
  incidents_30d: number;
  mtta_seconds: number | null;
  mttr_seconds: number | null;
};

function Stat({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums", alert ? "text-red-400" : "text-zinc-100")}>{value}</div>
    </div>
  );
}

const ALERT_STATUS_STYLE: Record<string, string> = {
  firing: "text-red-300",
  resolved: "text-emerald-400",
  suppressed: "text-zinc-500",
};

export default function DashboardPage() {
  const [declaring, setDeclaring] = useState(false);
  const anyIncidentChange = (e: { type: string }) => e.type.startsWith("incident.");
  const stats = useApi<{ stats: Stats }>("/stats", anyIncidentChange);
  const incidents = useApi<{ incidents: IncidentSummary[] }>("/incidents?status=open", anyIncidentChange);
  const services = useApi<{ services: Service[] }>("/services", (e) => e.type === "service.updated" || e.type === "incident.created");
  const alerts = useApi<{ alerts: AlertRow[] }>("/alerts", (e) => e.type === "alert.received" || e.type === "incident.updated");

  const s = stats.data?.stats;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Button variant="danger" onClick={() => setDeclaring(true)}>
          Declare incident
        </Button>
      </div>

      {stats.error ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Open incidents" value={s?.open_incidents ?? "—"} alert={!!s?.open_incidents} />
          <Stat label="Unacknowledged" value={s?.unacknowledged ?? "—"} alert={!!s?.unacknowledged} />
          <Stat label="Incidents (30d)" value={s?.incidents_30d ?? "—"} />
          <Stat label="MTTA (30d)" value={duration(s?.mtta_seconds)} />
          <Stat label="MTTR (30d)" value={duration(s?.mttr_seconds)} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Open incidents" className="lg:col-span-2" actions={<Link href="/incidents" className="text-xs text-zinc-400 hover:underline">All incidents →</Link>}>
          {incidents.error ? (
            <ErrorState message={incidents.error} onRetry={incidents.reload} />
          ) : incidents.loading ? (
            <Loading />
          ) : (
            <IncidentTable incidents={incidents.data!.incidents} empty="All clear — no open incidents." />
          )}
        </Card>

        <Card title="Service health" actions={<Link href="/services" className="text-xs text-zinc-400 hover:underline">Manage →</Link>}>
          {services.error ? (
            <ErrorState message={services.error} onRetry={services.reload} />
          ) : services.loading ? (
            <Loading />
          ) : (
            <ul className="divide-y divide-zinc-800">
              {services.data!.services.map((svc) => (
                <li key={svc.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-zinc-200">{svc.name}</span>
                  <span className="flex items-center gap-3">
                    {svc.open_incidents > 0 && <span className="text-xs text-zinc-500">{svc.open_incidents} open</span>}
                    <ServiceStatusPill status={svc.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Alert feed">
        {alerts.error ? (
          <ErrorState message={alerts.error} onRetry={alerts.reload} />
        ) : alerts.loading ? (
          <Loading />
        ) : alerts.data!.alerts.length === 0 ? (
          <Empty>No alerts received yet. Try <code>npm run simulate</code>.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800 text-sm">
            {alerts.data!.alerts.slice(0, 15).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className={cx("w-20 text-xs font-medium uppercase", ALERT_STATUS_STYLE[a.status])}>{a.status}</span>
                <span className="w-16 text-xs uppercase text-zinc-500">{a.severity}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{a.summary}</span>
                <span className="text-xs text-zinc-500">
                  {a.service_name} · {a.source}
                  {a.matched_rule && ` · rule: ${a.matched_rule}`}
                </span>
                {a.incident_number && (
                  <Link href={`/incidents/${a.incident_number}`} className="font-mono text-xs text-zinc-400 hover:underline">
                    {incidentRef(a.incident_number)}
                  </Link>
                )}
                <span className="w-16 text-right text-xs text-zinc-500">{timeAgo(a.received_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {declaring && <DeclareIncident onClose={() => setDeclaring(false)} />}
    </div>
  );
}
