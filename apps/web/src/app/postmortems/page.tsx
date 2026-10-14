"use client";

import Link from "next/link";
import { formatDurationLong, incidentRef } from "@irp/shared";
import { Card, cx, Empty, ErrorState, Loading, SeverityBadge } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { PostmortemSummary } from "@/lib/types";

// Every postmortem in the organization, newest incident first, with how
// much of the follow-up work is done.
export default function PostmortemsPage() {
  const list = useApi<{ postmortems: PostmortemSummary[] }>("/postmortems", (e) => e.type === "incident.updated");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Postmortems</h1>
        <p className="text-sm text-zinc-400">Drafted automatically when an incident is resolved, from its immutable timeline.</p>
      </div>
      <Card>
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <Loading />
        ) : list.data!.postmortems.length === 0 ? (
          <Empty>No postmortems yet. Resolve an incident to get the first draft.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 pr-3 font-medium">Incident</th>
                  <th className="pb-2 pr-3 font-medium">Severity</th>
                  <th className="pb-2 pr-3 font-medium">Duration</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 font-medium">Action items</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {list.data!.postmortems.map((p) => {
                  const pct = p.action_items_total ? Math.round((p.action_items_done / p.action_items_total) * 100) : 0;
                  return (
                    <tr key={p.number}>
                      <td className="py-2.5 pr-3">
                        <Link href={`/incidents/${p.number}/postmortem`} className="font-medium text-zinc-100 hover:underline">
                          {incidentRef(p.number)} · {p.title}
                        </Link>
                        <div className="text-xs text-zinc-500">{p.service_name ?? "no service"}</div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <SeverityBadge severity={p.severity} />
                      </td>
                      <td className="py-2.5 pr-3 text-zinc-300">{formatDurationLong(p.duration_seconds)}</td>
                      <td className="py-2.5 pr-3">
                        <span className={cx("text-xs font-medium", p.status === "published" ? "text-emerald-400" : "text-amber-300")}>
                          {p.status === "published" ? `Published ${p.published_at ? dateTime(p.published_at) : ""}` : "Draft"}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded bg-zinc-800">
                            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs tabular-nums text-zinc-400">
                            {p.action_items_done}/{p.action_items_total}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
