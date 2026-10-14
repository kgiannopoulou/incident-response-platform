"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { incidentRef } from "@irp/shared";
import { ALERT_SEVERITY_STYLE } from "@/components/alert-feed";
import { IncidentHeader } from "@/components/incident/incident-header";
import { IncidentTimeline } from "@/components/incident/incident-timeline";
import { RespondersCard } from "@/components/incident/responders-card";
import { Card, cx, Empty, ErrorState, Loading } from "@/components/ui";
import { post } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { clock, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { IncidentDetail, User } from "@/lib/types";

// The centerpiece: one incident, from the first alert to the postmortem.
//
//   ┌ header: INC-142 · title · status · severity · Acknowledge/Resolve/Escalate ┐
//   ├ timeline (2/3)                         │ responders · paging · alerts ·   │
//   │                                        │ postmortem                       │
//   └────────────────────────────────────────┴──────────────────────────────────┘
//
// Everything re-fetches when a realtime event for this incident arrives.
export default function IncidentPage() {
  const number = Number(useParams<{ number: string }>().number);
  const me = useUser();
  const detail = useApi<IncidentDetail>(`/incidents/${number}`, (e) => "incidentId" in e && e.type !== "incident.created");
  const users = useApi<{ users: User[] }>("/users");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/incidents/${number}${path}`, body);
      detail.reload();
      return true;
    } catch (err) {
      setActionError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const { incident, timeline, timeline_integrity, alerts, responders, notifications, postmortem } = detail.data;
  const open = incident.status !== "resolved";

  return (
    <div className="space-y-5">
      <div className="text-sm text-zinc-500">
        <Link href="/incidents" className="hover:underline">
          Incidents
        </Link>{" "}
        / {incidentRef(incident.number)}
      </div>

      <IncidentHeader incident={incident} busy={busy} error={actionError} act={act} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <IncidentTimeline
            timeline={timeline}
            integrity={timeline_integrity}
            canPost busy={busy} onNote={(message) => act("/notes", { message })} />
        </div>

        <div className="space-y-5">
          <RespondersCard responders={responders} users={users.data?.users ?? null} me={me} open={open} busy={busy} act={act} />

          <Card title={`Paging${incident.escalation_policy_name ? ` · ${incident.escalation_policy_name}` : ""}`}>
            {notifications.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No pages sent{incident.escalation_policy_name ? " yet" : " (service has no escalation policy)"}.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {notifications.map((n) => (
                  <li key={n.id} className="flex justify-between gap-2">
                    <span className="text-zinc-300">
                      {n.user_name}{" "}
                      <span className="text-xs text-zinc-500">
                        {n.kind}
                        {n.escalation_level ? ` · L${n.escalation_level}` : ""}
                      </span>
                    </span>
                    <span
                      className={cx(
                        "text-xs",
                        n.status === "sent" ? "text-emerald-400" : n.status === "failed" ? "text-red-400" : "text-zinc-500"
                      )}
                    >
                      {n.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Alerts (${alerts.length})`}>
            {alerts.length === 0 ? (
              <Empty>Declared manually — no alerts attached.</Empty>
            ) : (
              <ul className="space-y-3 text-sm">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <p className="flex items-center gap-2 text-zinc-200">
                      <span aria-hidden>{ALERT_SEVERITY_STYLE[a.severity].icon}</span>
                      {a.title}
                    </p>
                    {a.description && <p className="text-xs text-zinc-400">{a.description}</p>}
                    <p className="text-xs text-zinc-500">
                      {a.severity.toUpperCase()} · {a.source} · {clock(a.received_at)} ·{" "}
                      <span className={a.status === "triggered" ? "text-red-300" : "text-emerald-400"}>{a.status}</span>
                    </p>
                    {Object.keys(a.metadata).length > 0 && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={JSON.stringify(a.metadata)}>
                        {JSON.stringify(a.metadata)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Postmortem">
            {postmortem ? (
              <div className="flex items-center justify-between text-sm">
                <span className="capitalize text-zinc-300">
                  {postmortem.status} · updated {timeAgo(postmortem.updated_at)}
                </span>
                <Link href={`/incidents/${incident.number}/postmortem`} className="text-zinc-100 underline">
                  Open
                </Link>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">A draft is generated automatically when the incident is resolved.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
