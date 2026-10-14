"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertFeed } from "@/components/alert-feed";
import { DeclareIncident } from "@/components/declare-incident";
import { IncidentTable } from "@/components/incident-table";
import { Button, Card, cx, ErrorState, Loading, ServiceStatusPill } from "@/components/ui";
import { duration } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { AlertRow, IncidentSummary, Service } from "@/lib/types";

type Stats = {
  open_incidents: number;
  unacknowledged: number;
  incidents_30d: number;
  mtta_seconds: number | null;
  mttr_seconds: number | null;
  ack_timeouts_30d: number;
};

function Stat({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums", alert ? "text-red-400" : "text-zinc-100")}>{value}</div>
    </div>
  );
}

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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Open incidents" value={s?.open_incidents ?? "—"} alert={!!s?.open_incidents} />
          <Stat label="Unacknowledged" value={s?.unacknowledged ?? "—"} alert={!!s?.unacknowledged} />
          <Stat label="Incidents (30d)" value={s?.incidents_30d ?? "—"} />
          <Stat label="MTTA (30d)" value={duration(s?.mtta_seconds)} />
          <Stat label="MTTR (30d)" value={duration(s?.mttr_seconds)} />
          <Stat label="Missed ack timeouts (30d)" value={s?.ack_timeouts_30d ?? "—"} alert={!!s?.ack_timeouts_30d} />
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

      <Card title="Alerts" actions={<Link href="/alerts" className="text-xs text-zinc-400 hover:underline">All alerts →</Link>}>
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
