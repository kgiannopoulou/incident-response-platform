"use client";

import { useState } from "react";
import { INCIDENT_SEVERITIES } from "@irp/shared";
import { IncidentTable } from "@/components/incident-table";
import { Card, cx, ErrorState, inputClass, Loading } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import type { IncidentSummary } from "@/lib/types";

const FILTERS = ["open", "triggered", "acknowledged", "investigating", "resolved", "all"] as const;

export default function IncidentsPage() {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("open");
  const [severity, setSeverity] = useState("");
  const query = new URLSearchParams({ status, ...(severity ? { severity } : {}) });
  const incidents = useApi<{ incidents: IncidentSummary[] }>(`/incidents?${query}`, (e) => e.type.startsWith("incident."));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Incidents</h1>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setStatus(f)}
            className={cx("rounded-full px-3 py-1 text-sm capitalize", status === f ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700")}
          >
            {f}
          </button>
        ))}
        <select className={cx(inputClass, "ml-auto max-w-40")} value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <Card>
        {incidents.error ? (
          <ErrorState message={incidents.error} onRetry={incidents.reload} />
        ) : incidents.loading ? (
          <Loading />
        ) : (
          <IncidentTable incidents={incidents.data!.incidents} empty="No incidents match these filters." />
        )}
      </Card>
    </div>
  );
}
