"use client";

import Link from "next/link";
import { incidentRef, type AlertSeverity, type AlertStatus } from "@irp/shared";
import { timeAgo } from "@/lib/format";
import type { AlertRow } from "@/lib/types";
import { useNow } from "@/lib/use-now";
import { cx, Empty } from "./ui";

export const ALERT_SEVERITY_STYLE: Record<AlertSeverity, { icon: string; text: string }> = {
  critical: { icon: "🔴", text: "text-red-400" },
  high: { icon: "🟠", text: "text-orange-400" },
  warning: { icon: "🟡", text: "text-amber-300" },
  info: { icon: "🔵", text: "text-sky-400" },
};

export function AlertSeverityTag({ severity }: { severity: AlertSeverity }) {
  const style = ALERT_SEVERITY_STYLE[severity];
  return (
    <span className={cx("inline-flex w-28 shrink-0 items-center gap-2 text-xs font-semibold tracking-wide", style.text)}>
      <span aria-hidden>{style.icon}</span>
      {severity.toUpperCase()}
    </span>
  );
}

const STATUS_STYLE: Record<AlertStatus, string> = {
  triggered: "text-zinc-300",
  resolved: "text-emerald-400",
  suppressed: "text-zinc-500 line-through decoration-zinc-600",
};

//   🔴 CRITICAL  Checkout error rate exceeded threshold      12 sec ago
//   🟠 HIGH      Database latency                            43 sec ago
//   🟡 WARNING   CPU > 80%                                    3 min ago
export function AlertFeed({ alerts, limit, detailed = false }: { alerts: AlertRow[]; limit?: number; detailed?: boolean }) {
  const now = useNow();
  if (alerts.length === 0) return <Empty>No alerts yet. Try <code>npm run simulate</code>.</Empty>;

  return (
    <ul className="divide-y divide-zinc-800 text-sm">
      {alerts.slice(0, limit).map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <AlertSeverityTag severity={a.severity} />
          <span className={cx("min-w-0 flex-1 truncate font-medium", STATUS_STYLE[a.status])} title={a.description || a.title}>
            {a.title}
            {detailed && a.description && <span className="ml-2 font-normal text-zinc-500">{a.description}</span>}
          </span>
          <span className="text-xs text-zinc-500">
            {a.service_slug} · {a.source}
            {a.status !== "triggered" && ` · ${a.status}`}
            {a.matched_rule && ` · rule: ${a.matched_rule}`}
            {detailed && a.api_key_prefix && ` · key ${a.api_key_prefix}…`}
          </span>
          {a.incident_number && (
            <Link href={`/incidents/${a.incident_number}`} className="font-mono text-xs text-zinc-400 hover:underline">
              {incidentRef(a.incident_number)}
            </Link>
          )}
          <span className="w-24 text-right text-xs tabular-nums text-zinc-500" title={a.received_at}>
            {timeAgo(a.received_at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}
