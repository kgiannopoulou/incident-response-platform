"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, cx, inputClass } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { TimelineEvent, TimelineIntegrity } from "@/lib/types";

// The incident's story, oldest first, the way you'd read it back in a
// postmortem review:
//
//   14:02  🔴 Incident triggered
//   14:03  👤 Konstantina acknowledged
//   14:07  💬 "Database connections appear exhausted"
//
// Notes are posted from the box underneath. Events are append-only: there is
// no edit or delete, and the header shows whether the hash chain still
// verifies (a correction is just another note).

const ICON: Record<string, string> = {
  INCIDENT_CREATED: "🔴",
  ALERT_ATTACHED: "🔔",
  ALERT_RESOLVED: "✅",
  NOTIFICATION_SENT: "📟",
  INCIDENT_ESCALATED: "⏫",
  INCIDENT_ACKNOWLEDGED: "👤",
  SEVERITY_CHANGED: "🎚️",
  RESPONDER_ADDED: "🙋",
  COMMANDER_ASSIGNED: "🎖️",
  NOTE_ADDED: "💬",
  INCIDENT_RESOLVED: "🟢",
  INCIDENT_REOPENED: "♻️", // historical events only
  POSTMORTEM_GENERATED: "📄",
};

const STATUS_ICON: Record<string, string> = {
  investigating: "🔎",
  mitigated: "🔧",
};

function iconFor(e: TimelineEvent) {
  if (e.event_type === "STATUS_CHANGED") return STATUS_ICON[String(e.metadata?.to)] ?? "🔁";
  return ICON[e.event_type] ?? "•";
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Props = {
  timeline: TimelineEvent[];
  integrity: TimelineIntegrity;
  canPost: boolean;
  busy: boolean;
  onNote: (message: string) => Promise<boolean>;
};

function IntegrityBadge({ integrity }: { integrity: TimelineIntegrity }) {
  if (integrity.valid) {
    return (
      <span className="text-xs text-zinc-500" title="Append-only, hash-chained audit log: every event's hash covers the one before it">
        🔒 {integrity.events} events · chain verified
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-red-400" title="An event was edited or removed outside the application">
      ⚠ Chain broken at event #{integrity.first_invalid_id}
    </span>
  );
}

export function IncidentTimeline({ timeline, integrity, canPost, busy, onNote }: Props) {
  const [note, setNote] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await onNote(note)) setNote("");
  }

  return (
    <Card title="Timeline" actions={<IntegrityBadge integrity={integrity} />}>
      <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[4.1rem] before:top-2 before:w-px before:bg-zinc-800">
        {timeline.map((e) => (
          <li key={e.id} className="relative flex gap-3 text-sm">
            <time className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-zinc-500" title={dateTime(e.created_at)}>
              {hhmm(e.created_at)}
            </time>
            <span className="z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-900 text-sm" aria-hidden>
              {iconFor(e)}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx("break-words", e.event_type === "NOTE_ADDED" ? "text-zinc-50" : "text-zinc-300")}>
                {e.event_type === "NOTE_ADDED" ? `“${e.message}”` : e.message}
              </p>
              <p className="text-xs text-zinc-500">{e.actor_name ?? "system"}</p>
            </div>
          </li>
        ))}
      </ol>
      {canPost && (
        <form onSubmit={submit} className="mt-4 flex gap-2 border-t border-zinc-800 pt-4">
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
      )}
    </Card>
  );
}
