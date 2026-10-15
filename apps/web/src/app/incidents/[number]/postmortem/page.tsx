"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { formatDurationLong, incidentRef, sevLabel, UNCONFIRMED_ROOT_CAUSE, type ActionItem, type AiSection } from "@irp/shared";
import { AI_SECTION_TITLE, AiDraftPanel } from "@/components/postmortem/ai-draft-panel";
import { Button, Card, cx, ErrorState, inputClass, Loading } from "@/components/ui";
import { API_URL, patch, post, put } from "@/lib/api";
import { dateTime, duration, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { Postmortem } from "@/lib/types";

// The postmortem as a document, in the order a review meeting walks it:
//
//   INC-142 POSTMORTEM
//   Incident · Duration · Severity
//   Summary · Impact · Timeline · Root cause · Resolution
//   What went well · What went poorly · Action items
//
// The timeline comes from the incident's immutable event log; responders
// can hide entries from the document but never edit them. Publishing makes
// the text read-only; action items can still be ticked off afterwards.
//
// An optional AI draft (phase 16) sits below the header as a suggestion;
// sections a reviewer applies are badged "AI-assisted" and publishing needs
// an explicit "I have reviewed them" confirmation.

type DraftItem = Omit<ActionItem, "id"> & { id?: string };
type Draft = {
  summary: string;
  impact: string;
  root_cause: string;
  resolution: string;
  what_went_well: string;
  what_went_poorly: string;
  action_items: DraftItem[];
  hidden: number[];
};

type TextKey = "summary" | "impact" | "root_cause" | "resolution" | "what_went_well" | "what_went_poorly";
const AI_SECTION_OF: Record<TextKey, AiSection> = {
  summary: "summary",
  impact: "impact",
  root_cause: "rootCause",
  resolution: "resolution",
  what_went_well: "whatWentWell",
  what_went_poorly: "whatWentPoorly",
};

const SECTION: Record<TextKey, { title: string; hint: string; rows: number }> = {
  summary: { title: "Summary", hint: "What happened, in two or three sentences.", rows: 3 },
  impact: { title: "Impact", hint: "Who was affected and how badly — users, failed requests, revenue.", rows: 3 },
  root_cause: { title: "Root cause", hint: "Why it happened: the confirmed cause and contributing factors.", rows: 4 },
  resolution: { title: "Resolution", hint: "How it was mitigated and then fixed.", rows: 3 },
  what_went_well: { title: "What went well", hint: "Keep doing these.", rows: 4 },
  what_went_poorly: { title: "What went poorly", hint: "Where we lost time or got lucky.", rows: 4 },
};

const TIMELINE_ICON: Record<string, string> = {
  INCIDENT_CREATED: "🔴",
  ALERT_ATTACHED: "🔔",
  ALERT_RESOLVED: "🟢",
  NOTIFICATION_SENT: "📟",
  INCIDENT_ESCALATED: "⏫",
  ACK_TIMEOUT: "⏰",
  INCIDENT_ACKNOWLEDGED: "👤",
  COMMANDER_ASSIGNED: "🎖️",
  STATUS_CHANGED: "🔁",
  SEVERITY_CHANGED: "⚠️",
  NOTE_ADDED: "💬",
  INCIDENT_RESOLVED: "✅",
};

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-zinc-100">{children}</dd>
    </div>
  );
}

export default function PostmortemPage() {
  const number = Number(useParams<{ number: string }>().number);
  const pm = useApi<{ postmortem: Postmortem }>(`/incidents/${number}/postmortem`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiReviewed, setAiReviewed] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Seed the editable copy whenever a new server copy arrives (first load,
  // or the reload after a save) — React's "adjust state while rendering"
  // pattern, rather than an effect.
  const [seededFrom, setSeededFrom] = useState<unknown>(null);
  if (pm.data && pm.data !== seededFrom) {
    const p = pm.data.postmortem;
    setSeededFrom(pm.data);
    setDraft({
      summary: p.summary,
      impact: p.impact,
      root_cause: p.root_cause,
      resolution: p.resolution,
      what_went_well: p.what_went_well,
      what_went_poorly: p.what_went_poorly,
      action_items: p.action_items,
      hidden: p.timeline.filter((e) => e.hidden && e.eventId !== null).map((e) => e.eventId!),
    });
  }

  if (pm.error) {
    return (
      <div className="space-y-3">
        <ErrorState message={pm.error} onRetry={pm.reload} />
        <Link href={`/incidents/${number}`} className="text-sm underline">
          ← Back to {incidentRef(number)}
        </Link>
      </div>
    );
  }
  if (!pm.data || !draft) return <Loading />;
  const p = pm.data.postmortem;
  const published = p.status === "published";

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setSaving(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ kind: "ok", text: ok });
      pm.reload();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const body = (status?: "draft" | "published") => ({
    summary: draft!.summary,
    impact: draft!.impact,
    rootCause: draft!.root_cause,
    resolution: draft!.resolution,
    whatWentWell: draft!.what_went_well,
    whatWentPoorly: draft!.what_went_poorly,
    actionItems: draft!.action_items.filter((a) => a.description.trim()),
    hiddenTimelineEventIds: draft!.hidden,
    ...(aiReviewed && p.ai_review_pending ? { aiReviewed: true as const } : {}),
    ...(status ? { status } : {}),
  });

  const setItem = (i: number, patchItem: Partial<DraftItem>) =>
    setDraft({ ...draft, action_items: draft.action_items.map((a, j) => (i === j ? { ...a, ...patchItem } : a)) });
  const toggleHidden = (eventId: number) =>
    setDraft({ ...draft, hidden: draft.hidden.includes(eventId) ? draft.hidden.filter((id) => id !== eventId) : [...draft.hidden, eventId] });

  const m = p.metrics;
  const doneCount = p.action_items.filter((a) => a.done).length;

  const aiAssisted = (key: TextKey | "actionItems") =>
    p.ai_assisted_sections.includes(key === "actionItems" ? "actionItems" : AI_SECTION_OF[key]) && (
      <span className="ml-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-300" title="Seeded from an AI draft">
        AI-assisted
      </span>
    );

  const textSection = (key: TextKey) => (
    <Card
      key={key}
      title={
        <>
          {SECTION[key].title}
          {aiAssisted(key)}
        </>
      }
    >
      {published ? (
        <p className="whitespace-pre-wrap text-sm text-zinc-200">{p[key] || <span className="text-zinc-500">—</span>}</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-500">{SECTION[key].hint}</p>
          <textarea
            className={inputClass}
            rows={SECTION[key].rows}
            aria-label={SECTION[key].title}
            value={draft[key]}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </>
      )}
    </Card>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="text-sm text-zinc-500">
        <Link href="/postmortems" className="hover:underline">
          Postmortems
        </Link>{" "}
        /{" "}
        <Link href={`/incidents/${number}`} className="hover:underline">
          {incidentRef(number)}
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {incidentRef(p.number)} <span className="text-zinc-400">POSTMORTEM</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", published ? "bg-emerald-600 text-white" : "bg-amber-400 text-zinc-950")}>
              {published ? "Published" : "Draft"}
            </span>{" "}
            {published && p.published_at
              ? `by ${p.published_by_name ?? "—"} on ${dateTime(p.published_at)}`
              : `updated ${timeAgo(p.updated_at)}${p.updated_by_name ? ` by ${p.updated_by_name}` : ""}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            href={`${API_URL}/api/v1/incidents/${number}/postmortem/markdown`}
          >
            Export .md
          </a>
          {published ? (
            <Button variant="ghost" disabled={saving} onClick={() => run(() => put(`/incidents/${number}/postmortem`, { status: "draft" }), "Reopened as a draft.")}>
              Reopen as draft
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => run(() => post(`/incidents/${number}/postmortem`), "Metrics and timeline refreshed.")} disabled={saving} title="Rebuild metrics and timeline from the event log; your text is kept">
                Refresh data
              </Button>
              <Button variant="ghost" onClick={() => run(() => put(`/incidents/${number}/postmortem`, body()), "Saved.")} disabled={saving}>
                Save draft
              </Button>
              <Button variant="success" onClick={() => run(() => put(`/incidents/${number}/postmortem`, body("published")), "Published.")} disabled={saving}>
                Publish
              </Button>
            </>
          )}
        </div>
      </header>
      {message && (message.kind === "error" ? <ErrorState message={message.text} /> : <p className="text-sm text-emerald-400">{message.text}</p>)}

      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Incident">{p.title}</Fact>
          <Fact label="Duration">
            {formatDurationLong(m.durationSeconds ?? m.timeToResolveSeconds ?? null)}
            <span className="block text-xs text-zinc-500">
              {new Date(p.triggered_at).toLocaleDateString([], { dateStyle: "medium" })} · {hhmm(p.triggered_at)} → {p.resolved_at ? hhmm(p.resolved_at) : "…"}
            </span>
          </Fact>
          <Fact label="Severity">{sevLabel(p.severity)}</Fact>
          <Fact label="Service">{p.service_name ?? "—"}</Fact>
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-zinc-800 pt-4 sm:grid-cols-4 lg:grid-cols-8">
          {[
            ["To acknowledge", duration(m.timeToAcknowledgeSeconds)],
            ["To mitigate", duration(m.timeToMitigateSeconds)],
            ["To resolve", duration(m.timeToResolveSeconds)],
            ["Alerts", m.alertCount ?? "—"],
            ["Escalations", m.escalations ?? "—"],
            ["Ack timeouts", m.ackTimeouts ?? 0],
            ["Notes", m.notesCount ?? "—"],
            ["Responders", m.responderCount ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded bg-zinc-950/60 px-2.5 py-1.5">
              <div className="text-[11px] text-zinc-500">{label}</div>
              <div className="font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      </Card>

      {!published && p.ai_review_pending && (
        <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-4 text-sm text-violet-100">
          <p>
            <span className="font-semibold">Review AI-assisted sections before publishing:</span>{" "}
            {p.ai_assisted_sections.map((s) => AI_SECTION_TITLE[s]).join(", ")}. Check them against the timeline and rewrite anything the data
            doesn&apos;t support.
            {draft.root_cause.includes(UNCONFIRMED_ROOT_CAUSE) && " The root cause is still marked as an unconfirmed hypothesis — replace it with the confirmed cause."}
          </p>
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={aiReviewed} onChange={(e) => setAiReviewed(e.target.checked)} />I have reviewed and edited the AI-assisted
            sections
          </label>
        </div>
      )}
      {published && p.ai_assisted_sections.length > 0 && (
        <p className="text-xs text-zinc-500">
          Drafted with AI assistance ({p.ai_assisted_sections.map((s) => AI_SECTION_TITLE[s]).join(", ")}){p.ai_reviewed_by_name ? `; reviewed by ${p.ai_reviewed_by_name}` : ""}.
          The timeline comes from the event log.
        </p>
      )}

      <AiDraftPanel number={number} published={published} timeline={p.timeline} onApplied={pm.reload} />

      {textSection("summary")}
      {textSection("impact")}

      <Card
        title="Timeline"
        actions={<span className="text-xs text-zinc-500">from the append-only, hash-chained event log</span>}
      >
        {p.timeline.length === 0 ? (
          <p className="text-sm text-zinc-500">No timeline yet — use “Refresh data” to build it from the event log.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {p.timeline.map((e, i) => {
              const hidden = e.eventId !== null && draft.hidden.includes(e.eventId);
              if (published && hidden) return null;
              return (
                <li key={e.eventId ?? i} className={cx("group flex items-start gap-3", hidden && "opacity-40")}>
                  <span className="w-12 shrink-0 font-mono text-xs leading-5 text-zinc-400">{hhmm(e.at)}</span>
                  <span className="w-5 shrink-0 text-center">{TIMELINE_ICON[e.type] ?? "•"}</span>
                  <span className={cx("flex-1 text-zinc-200", hidden && "line-through")}>
                    {e.message}
                    {e.actor && <span className="text-zinc-500"> — {e.actor}</span>}
                  </span>
                  {!published && e.eventId !== null && (
                    <button
                      className="shrink-0 text-xs text-zinc-500 hover:text-zinc-100"
                      onClick={() => toggleHidden(e.eventId!)}
                      title={hidden ? "Include in the document" : "Leave out of the document (the event itself stays in the log)"}
                    >
                      {hidden ? "show" : "hide"}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {textSection("root_cause")}
      {textSection("resolution")}
      <div className="grid gap-5 md:grid-cols-2">
        {textSection("what_went_well")}
        {textSection("what_went_poorly")}
      </div>

      <Card
        title={
          <>
            {`Action items (${doneCount}/${p.action_items.length} done)`}
            {aiAssisted("actionItems")}
          </>
        }
        actions={
          !published && (
            <Button variant="ghost" onClick={() => setDraft({ ...draft, action_items: [...draft.action_items, { description: "", owner: "", dueDate: null, done: false }] })}>
              + Add
            </Button>
          )
        }
      >
        {published ? (
          <ul className="space-y-2 text-sm">
            {p.action_items.map((a) => (
              <li key={a.id} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={a.done}
                  aria-label={`Done: ${a.description}`}
                  onChange={(e) => run(() => patch(`/incidents/${number}/postmortem/action-items/${a.id}`, { done: e.target.checked }))}
                />
                <span className={cx("flex-1", a.done ? "text-zinc-500 line-through" : "text-zinc-100")}>{a.description}</span>
                <span className="text-xs text-zinc-400">{a.owner || "no owner"}</span>
                {a.dueDate && <span className="text-xs text-zinc-500">due {a.dueDate}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-2">
            {draft.action_items.map((a, i) => (
              <li key={a.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={a.done} onChange={(e) => setItem(i, { done: e.target.checked })} aria-label="Done" />
                <input className={cx(inputClass, "min-w-48 flex-1")} value={a.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="What needs to happen" />
                <input className={cx(inputClass, "w-32")} value={a.owner} onChange={(e) => setItem(i, { owner: e.target.value })} placeholder="Owner" />
                <input
                  type="date"
                  className={cx(inputClass, "w-40")}
                  value={a.dueDate ?? ""}
                  aria-label="Due date"
                  onChange={(e) => setItem(i, { dueDate: e.target.value || null })}
                />
                <button
                  className="text-zinc-500 hover:text-red-300"
                  onClick={() => setDraft({ ...draft, action_items: draft.action_items.filter((_, j) => j !== i) })}
                  aria-label="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
