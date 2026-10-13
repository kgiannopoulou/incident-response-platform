"use client";

import Link from "next/link";
import { incidentRef } from "@irp/shared";
import { timeAgo } from "@/lib/format";
import type { IncidentSummary } from "@/lib/types";
import { Empty, SeverityBadge, StatusBadge } from "./ui";

export function IncidentTable({ incidents, empty }: { incidents: IncidentSummary[]; empty: string }) {
  if (incidents.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="pb-2 pr-3 font-medium">Incident</th>
            <th className="pb-2 pr-3 font-medium">Severity</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2 pr-3 font-medium">Service</th>
            <th className="pb-2 pr-3 font-medium">Commander</th>
            <th className="pb-2 pr-3 text-right font-medium">Alerts</th>
            <th className="pb-2 text-right font-medium">Opened</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {incidents.map((i) => (
            <tr key={i.id} className="hover:bg-zinc-800/40">
              <td className="py-2 pr-3">
                <Link href={`/incidents/${i.number}`} className="font-medium text-zinc-100 hover:underline">
                  <span className="mr-2 font-mono text-zinc-500">{incidentRef(i.number)}</span>
                  {i.title}
                </Link>
                {i.status === "triggered" && i.escalation_level > 1 && (
                  <span className="ml-2 text-xs text-red-300">escalated to L{i.escalation_level}</span>
                )}
              </td>
              <td className="py-2 pr-3">
                <SeverityBadge severity={i.severity} />
              </td>
              <td className="py-2 pr-3">
                <StatusBadge status={i.status} />
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-zinc-300">{i.service_name ?? "—"}</td>
              <td className="py-2 pr-3 text-zinc-400">{i.commander_name ?? "—"}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">{i.alert_count}</td>
              <td className="whitespace-nowrap py-2 text-right text-zinc-400" title={i.triggered_at}>
                {timeAgo(i.triggered_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
