"use client";

import { useState, type FormEvent } from "react";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  incidentRef,
  type IncidentSeverity,
  type IncidentStatus,
} from "@irp/shared";
import { Button, cx, ErrorState, inputClass, ServiceStatusPill, StatusBadge } from "@/components/ui";
import { dateTime, duration, timeAgo, timeUntil } from "@/lib/format";
import type { IncidentDetail } from "@/lib/types";
import { useNow } from "@/lib/use-now";

// The top of the incident page: what is broken, how bad, since when, and the
// actions a responder takes next. Which status buttons appear comes from the
// API's allowed_transitions, so the UI never offers a move the state machine
// would reject.

const TRANSITION: Record<Exclude<IncidentStatus, "triggered">, { label: string; variant: "primary" | "ghost" | "success" }> = {
  acknowledged: { label: "Acknowledge", variant: "primary" },
  investigating: { label: "Start investigating", variant: "ghost" },
  mitigated: { label: "Mark mitigated", variant: "ghost" },
  resolved: { label: "Resolve", variant: "success" },
};

const SEVERITY_BANNER: Record<IncidentSeverity, string> = {
  sev1: "bg-red-600 text-white",
  sev2: "bg-orange-500 text-zinc-950",
  sev3: "bg-amber-400 text-zinc-950",
  sev4: "bg-sky-500 text-white",
};

const SEVERITY_WORD: Record<IncidentSeverity, string> = {
  sev1: "CRITICAL",
  sev2: "MAJOR",
  sev3: "MINOR",
  sev4: "LOW",
};

const seconds = (from: string, to: string | null) => (to ? Math.round((+new Date(to) - +new Date(from)) / 1000) : null);

type Props = {
  incident: IncidentDetail["incident"];
  busy: boolean;
  readOnly: boolean; // observers watch; they can't change the incident
  error: string | null;
  act: (path: string, body?: unknown) => Promise<boolean>;
};

export function IncidentHeader({ incident, busy: working, readOnly, error, act }: Props) {
  const busy = working || readOnly;
  const now = useNow();
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const open = incident.status !== "resolved";
  const canEscalate =
    open && incident.escalation_max_level !== null && incident.escalation_level < incident.escalation_max_level;

  async function transition(to: IncidentStatus) {
    if (to === "resolved") return setResolving(true);
    await act("/status", { status: to });
  }

  async function resolve(e: FormEvent) {
    e.preventDefault();
    if (await act("/status", { status: "resolved", message: resolution || undefined })) {
      setResolving(false);
      setResolution("");
    }
  }

  const facts: [string, string, string?][] = [
    ["Started", timeAgo(incident.triggered_at, now), dateTime(incident.triggered_at)],
    ["Alerts", String(incident.alert_count), incident.last_alert_at ? `last ${timeAgo(incident.last_alert_at, now)}` : undefined],
    ["Time to acknowledge", duration(seconds(incident.triggered_at, incident.acknowledged_at))],
    ["Time to mitigate", duration(seconds(incident.triggered_at, incident.mitigated_at))],
    ["Time to resolve", duration(seconds(incident.triggered_at, incident.resolved_at))],
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0 space-y-2">
          <p className="font-mono text-sm text-zinc-400">{incidentRef(incident.number)}</p>
          <h1 className="text-2xl font-semibold leading-tight text-zinc-50">{incident.title}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-400">
            <span className="flex items-center gap-2">
              Status: <StatusBadge status={incident.status} />
            </span>
            <span>
              Service: <span className="text-zinc-200">{incident.service_name ?? "—"}</span>{" "}
              {incident.service_status && <ServiceStatusPill status={incident.service_status} />}
            </span>
            <span>
              Commander: <span className="text-zinc-200">{incident.commander_name ?? "unassigned"}</span>
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={cx("rounded-md px-3 py-1 text-sm font-bold tracking-wider", SEVERITY_BANNER[incident.severity])}>
            {SEVERITY_WORD[incident.severity]}
          </span>
          <select
            className={cx(inputClass, "w-40 py-1 text-xs")}
            value={incident.severity}
            disabled={busy || !open}
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
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-zinc-800 bg-zinc-800 sm:grid-cols-5">
        {facts.map(([label, value, hint]) => (
          <div key={label} className="bg-zinc-900 px-4 py-2.5" title={hint}>
            <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
            <dd className="tabular-nums text-zinc-100">
              {value}
              {hint && label === "Alerts" && <span className="ml-1.5 text-xs text-zinc-500">{hint}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {incident.allowed_transitions.map((to) => {
            if (to === "triggered") return null;
            const t = TRANSITION[to];
            return (
              <Button key={to} variant={t.variant} disabled={busy} onClick={() => transition(to)}>
                {t.label}
              </Button>
            );
          })}
          {open && (
            <Button
              variant="danger"
              disabled={busy || !canEscalate}
              onClick={() => act("/escalate")}
              title={
                incident.escalation_max_level === null
                  ? "This service has no escalation policy"
                  : canEscalate
                    ? `Page escalation level ${incident.escalation_level + 1} now`
                    : "Every escalation level has been paged"
              }
            >
              Escalate{canEscalate ? ` → L${incident.escalation_level + 1}` : ""}
            </Button>
          )}
          {!open && <span className="text-sm text-zinc-500">Resolved incidents are final; a recurrence opens a new incident.</span>}
          {open && readOnly && (
            <span className="text-sm text-zinc-500">You&apos;re observing — join as a responder to act.</span>
          )}
          {incident.ack_deadline_at && (
            <span
              className="rounded bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-200 ring-1 ring-red-500/40"
              title="High-urgency incidents escalate early if nobody acknowledges them in time"
            >
              ⏰ Acknowledge {timeUntil(incident.ack_deadline_at, now)} or this {incident.severity.toUpperCase()} escalates early
            </span>
          )}
          {incident.ack_timed_out_at && (
            <span className="text-xs text-red-300">Acknowledgement timeout missed — escalated early</span>
          )}
          {incident.next_escalation_at && (
            <span className="text-xs text-amber-300">
              Auto-escalates to L{incident.escalation_level + 1} {timeUntil(incident.next_escalation_at, now)} unless acknowledged
            </span>
          )}
        </div>

        {resolving && (
          <form onSubmit={resolve} className="flex flex-wrap gap-2">
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
        {error && <ErrorState message={error} />}
      </div>
    </section>
  );
}
