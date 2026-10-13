"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  incidentRef,
  type IncidentSeverity,
  type IncidentStatus,
} from "@irp/shared";
import { ALERT_SEVERITY_STYLE } from "@/components/alert-feed";
import { Button, Card, cx, Empty, ErrorState, inputClass, Loading, SeverityBadge, ServiceStatusPill, StatusBadge } from "@/components/ui";
import { post } from "@/lib/api";
import { clock, dateTime, duration, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { IncidentDetail, User } from "@/lib/types";

const TIMELINE_ICON: Record<string, string> = {
  incident_created: "🚨",
  alert_attached: "🔔",
  alert_resolved: "✅",
  notified: "📟",
  escalated: "⏫",
  acknowledged: "👀",
  status_changed: "🔎",
  severity_changed: "🎚️",
  responder_added: "🙋",
  commander_assigned: "🎖️",
  note: "📝",
  resolved: "🟢",
  reopened: "♻️",
  postmortem_generated: "📄",
};

const TRANSITION_LABEL: Record<IncidentStatus, { label: string; variant: "danger" | "primary" | "success" | "ghost" }> = {
  acknowledged: { label: "Acknowledge", variant: "primary" },
  investigating: { label: "Start investigating", variant: "ghost" },
  resolved: { label: "Resolve", variant: "success" },
  triggered: { label: "Trigger", variant: "danger" },
};

export default function IncidentPage() {
  const number = Number(useParams<{ number: string }>().number);
  const detail = useApi<IncidentDetail>(`/incidents/${number}`, (e) => "incidentId" in e && e.type !== "incident.created");
  const users = useApi<{ users: User[] }>("/users");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");

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
  const { incident, timeline, alerts, responders, notifications, postmortem } = detail.data;
  const reopening = incident.status === "resolved";

  async function handleTransition(to: IncidentStatus) {
    if (to === "resolved") return setResolving(true);
    await act("/status", { status: to });
  }

  async function handleResolve(e: FormEvent) {
    e.preventDefault();
    if (await act("/status", { status: "resolved", message: resolution || undefined })) {
      setResolving(false);
      setResolution("");
    }
  }

  async function handleNote(e: FormEvent) {
    e.preventDefault();
    if (await act("/notes", { message: note })) setNote("");
  }

  const responderIds = new Set(responders.map((r) => r.id));

  return (
    <div className="space-y-5">
      <div className="text-sm text-zinc-500">
        <Link href="/incidents" className="hover:underline">
          Incidents
        </Link>{" "}
        / {incidentRef(incident.number)}
      </div>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-zinc-500">{incidentRef(incident.number)}</span>
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
        </div>
        <h1 className="text-2xl font-semibold">{incident.title}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-400">
          <div>
            Service: <span className="text-zinc-200">{incident.service_name ?? "—"}</span>{" "}
            {incident.service_status && <ServiceStatusPill status={incident.service_status} />}
          </div>
          <div>
            Commander: <span className="text-zinc-200">{incident.commander_name ?? "unassigned"}</span>
          </div>
          <div title={dateTime(incident.triggered_at)}>Opened {timeAgo(incident.triggered_at)}</div>
          {incident.acknowledged_at && (
            <div>
              Time to acknowledge:{" "}
              <span className="text-zinc-200">
                {duration(Math.round((+new Date(incident.acknowledged_at) - +new Date(incident.triggered_at)) / 1000))}
              </span>
            </div>
          )}
          {incident.resolved_at && (
            <div>
              Time to resolve:{" "}
              <span className="text-zinc-200">
                {duration(Math.round((+new Date(incident.resolved_at) - +new Date(incident.triggered_at)) / 1000))}
              </span>
            </div>
          )}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {incident.allowed_transitions.map((to) => {
            const t = reopening && to === "investigating" ? { label: "Reopen", variant: "ghost" as const } : TRANSITION_LABEL[to];
            return (
              <Button key={to} variant={t.variant} disabled={busy} onClick={() => handleTransition(to)}>
                {t.label}
              </Button>
            );
          })}
          <select
            className={cx(inputClass, "max-w-48")}
            value={incident.severity}
            disabled={busy || reopening}
            onChange={(e) => act("/severity", { severity: e.target.value as IncidentSeverity })}
            aria-label="Severity"
          >
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {resolving && (
          <form onSubmit={handleResolve} className="flex flex-wrap gap-2">
            <input
              className={cx(inputClass, "min-w-64 flex-1")}
              placeholder="How was it resolved? (goes into the postmortem)"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              autoFocus
            />
            <Button type="submit" variant="success" disabled={busy}>
              Confirm resolve
            </Button>
            <Button type="button" variant="ghost" onClick={() => setResolving(false)}>
              Cancel
            </Button>
          </form>
        )}
        {actionError && <ErrorState message={actionError} />}
      </header>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Timeline" className="lg:col-span-2">
          <form onSubmit={handleNote} className="mb-4 flex gap-2">
            <input
              className={inputClass}
              placeholder="Add a note: what you tried, what you found…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" disabled={busy || !note.trim()}>
              Post
            </Button>
          </form>
          <ol className="space-y-3">
            {[...timeline].reverse().map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="w-6 shrink-0 text-center">{TIMELINE_ICON[e.type] ?? "•"}</span>
                <div className="min-w-0 flex-1">
                  <p className={cx("break-words", e.type === "note" ? "text-zinc-100" : "text-zinc-300")}>{e.message}</p>
                  <p className="text-xs text-zinc-500">
                    {clock(e.created_at)} · {e.actor_name ?? "system"}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-5">
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

          <Card title="Responders">
            <ul className="space-y-1 text-sm">
              {responders.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span className="text-zinc-200">{r.name}</span>
                  <span className="text-xs capitalize text-zinc-500">{r.role}</span>
                </li>
              ))}
              {responders.length === 0 && <li className="text-zinc-500">Nobody has joined yet.</li>}
            </ul>
            {users.data && (
              <select
                className={cx(inputClass, "mt-3")}
                value=""
                disabled={busy}
                onChange={(e) => act("/responders", { userId: Number(e.target.value), role: "responder" })}
                aria-label="Add responder"
              >
                <option value="">+ Add responder…</option>
                {users.data.users
                  .filter((u) => !responderIds.has(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            )}
          </Card>

          <Card title={`Paging${incident.escalation_policy_name ? ` · ${incident.escalation_policy_name}` : ""}`}>
            {incident.next_escalation_at && (
              <p className="mb-2 text-xs text-amber-300">
                Escalates to the next level at {clock(incident.next_escalation_at)} unless acknowledged.
              </p>
            )}
            {notifications.length === 0 ? (
              <p className="text-sm text-zinc-500">No pages sent{incident.escalation_policy_name ? " yet" : " (service has no escalation policy)"}.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {notifications.map((n) => (
                  <li key={n.id} className="flex justify-between gap-2">
                    <span className="text-zinc-300">
                      {n.user_name} <span className="text-xs text-zinc-500">{n.kind}{n.escalation_level ? ` · L${n.escalation_level}` : ""}</span>
                    </span>
                    <span className={cx("text-xs", n.status === "sent" ? "text-emerald-400" : n.status === "failed" ? "text-red-400" : "text-zinc-500")}>
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
        </div>
      </div>
    </div>
  );
}
