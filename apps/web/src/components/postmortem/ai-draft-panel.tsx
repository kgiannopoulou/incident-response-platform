"use client";

import { useState } from "react";
import type { AiSection, PostmortemTimelineEntry } from "@irp/shared";
import { Button, Card, cx, ErrorState } from "@/components/ui";
import { post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { AiDraft } from "@/lib/types";

// The AI draft as a *suggestion*: each section next to a checkbox, every
// claim with the timeline events it cites, the validator's warnings and the
// questions a person still has to answer. Nothing reaches the postmortem
// until the reviewer picks sections and clicks Apply — and even then the
// root cause arrives marked as an unconfirmed hypothesis.

export const AI_SECTION_TITLE: Record<AiSection, string> = {
  summary: "Incident summary",
  impact: "Customer impact",
  rootCause: "Probable root cause",
  resolution: "Response summary",
  whatWentWell: "What went well",
  whatWentPoorly: "What could improve",
  actionItems: "Suggested action items",
};

type EventIndex = Map<number, PostmortemTimelineEntry>;

// The timeline events a statement cites, as "#812 14:07" chips (hover for
// the event text) — or a warning chip when it cites none.
function Evidence({ ids, events }: { ids: number[]; events: EventIndex }) {
  if (!ids.length) return <span className="ml-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">no cited event</span>;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const entry = events.get(id);
        return (
          <span
            key={id}
            title={entry ? `${entry.message}${entry.actor ? ` — ${entry.actor}` : ""}` : "Event in the incident log (not shown in the curated timeline)"}
            className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
          >
            #{id}
            {entry && ` ${new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`}
          </span>
        );
      })}
    </span>
  );
}

function Points({ points, events }: { points: { point: string; evidenceEventIds: number[] }[]; events: EventIndex }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {points.map((p, i) => (
        <li key={i}>
          {p.point}
          <Evidence ids={p.evidenceEventIds} events={events} />
        </li>
      ))}
    </ul>
  );
}

function DraftSection(props: {
  id: AiSection;
  selected: boolean;
  applied: boolean;
  selectable: boolean;
  onToggle: (id: AiSection) => void;
  children: React.ReactNode;
}) {
  const { id, selected, applied, selectable, onToggle, children } = props;
  return (
    <div className={cx("rounded-md border p-3", selected ? "border-violet-500/60 bg-violet-500/5" : "border-zinc-800")}>
      <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {selectable && <input type="checkbox" checked={selected} onChange={() => onToggle(id)} aria-label={`Use ${AI_SECTION_TITLE[id]}`} />}
        {AI_SECTION_TITLE[id]}
        {applied && <span className="rounded bg-emerald-600/20 px-1.5 py-0.5 text-[10px] normal-case text-emerald-300">applied</span>}
      </label>
      <div className="text-sm text-zinc-200">{children}</div>
    </div>
  );
}

type Props = {
  number: number;
  published: boolean;
  timeline: PostmortemTimelineEntry[];
  onApplied: () => void;
};

export function AiDraftPanel({ number, published, timeline, onApplied }: Props) {
  const drafts = useApi<{ drafts: AiDraft[] }>(`/incidents/${number}/postmortem/ai-drafts`, (e) => e.type === "incident.updated" && "number" in e && e.number === number);
  const [selected, setSelected] = useState<Set<AiSection>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = drafts.data?.drafts.find((d) => d.status !== "discarded") ?? null;
  const base = `/incidents/${number}/postmortem/ai-drafts`;

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      drafts.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const generate = () => run(() => post(base), () => setSelected(new Set()));

  if (drafts.error) return <ErrorState message={drafts.error} onRetry={drafts.reload} />;
  if (!drafts.data) return null;

  if (!latest) {
    if (published) return null;
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium text-zinc-100">Draft the narrative with AI</p>
            <p className="text-zinc-400">
              Uses the incident metadata, alerts, responder notes, timeline and resolution. You choose which sections to use and review them
              before publishing — the timeline above stays the source of truth.
            </p>
          </div>
          <Button onClick={generate} disabled={busy}>
            ✨ Generate draft
          </Button>
        </div>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      </Card>
    );
  }

  const events: EventIndex = new Map(timeline.filter((e) => e.eventId !== null).map((e) => [e.eventId!, e]));

  const providerLabel =
    latest.provider === "rules" ? "Offline rules (no AI model configured)" : latest.provider === "claude" ? `Claude · ${latest.model ?? ""}` : "…";

  const header = (
    <span className="flex items-center gap-2">
      ✨ AI draft <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-normal text-zinc-400">suggestion</span>
    </span>
  );

  if (latest.status === "queued" || latest.status === "generating") {
    return (
      <Card title={header}>
        <p className="flex items-center gap-2 text-sm text-zinc-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          {latest.status === "queued" ? "Queued…" : "Drafting from the incident's alerts, notes and timeline…"}
          <span className="text-zinc-500">requested {timeAgo(latest.created_at)}{latest.attempts > 1 ? ` · attempt ${latest.attempts}` : ""}</span>
        </p>
      </Card>
    );
  }

  if (latest.status === "failed") {
    return (
      <Card title={header}>
        <ErrorState message={`The draft failed: ${latest.error ?? "unknown error"}`} />
        {!published && (
          <Button className="mt-3" onClick={generate} disabled={busy}>
            Try again
          </Button>
        )}
      </Card>
    );
  }

  const out = latest.output!;
  const toggle = (s: AiSection) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSelected(next);
  };
  const section = (id: AiSection) => ({
    id,
    selected: selected.has(id),
    applied: latest.applied_sections.includes(id),
    selectable: !published,
    onToggle: toggle,
  });

  return (
    <Card
      title={header}
      actions={
        <span className="text-xs text-zinc-500">
          {providerLabel} · {latest.input_events ?? "?"} events · {timeAgo(latest.completed_at)}
          {latest.usage?.inputTokens ? ` · ${latest.usage.inputTokens + (latest.usage.outputTokens ?? 0)} tokens` : ""}
        </span>
      }
    >
      <p className="mb-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200">
        AI-generated text is a draft. Check every statement against the timeline (the <span className="font-mono">#id</span> chips are the events
        it cites); applied sections must be reviewed before publishing, and the root cause stays marked as a hypothesis until you confirm it.
      </p>
      {latest.warnings.length > 0 && (
        <ul className="mb-3 space-y-1 text-xs text-amber-300">
          {latest.warnings.map((w, i) => (
            <li key={i}>⚠ {w.message}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <DraftSection {...section("summary")}>{out.incidentSummary}</DraftSection>
        <DraftSection {...section("impact")}>{out.customerImpact}</DraftSection>
        <DraftSection {...section("rootCause")}>
          {out.probableRootCause.statement}
          <Evidence ids={out.probableRootCause.evidenceEventIds} events={events} />
          <span
            className={cx(
              "ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase",
              { low: "bg-red-500/15 text-red-300", medium: "bg-amber-500/15 text-amber-300", high: "bg-emerald-500/15 text-emerald-300" }[
                out.probableRootCause.confidence
              ]
            )}
          >
            {out.probableRootCause.confidence} confidence
          </span>
        </DraftSection>
        <DraftSection {...section("resolution")}>{out.responseSummary}</DraftSection>
        <DraftSection {...section("whatWentWell")}>
          <Points points={out.whatWentWell} events={events} />
        </DraftSection>
        <DraftSection {...section("whatWentPoorly")}>
          <Points points={out.whatCouldImprove} events={events} />
        </DraftSection>
        <div className="md:col-span-2">
          <DraftSection {...section("actionItems")}>
            <ul className="space-y-1">
              {out.suggestedActionItems.map((a, i) => (
                <li key={i}>
                  ☐ {a.description} <span className="text-zinc-500">— {a.rationale}</span>
                  <Evidence ids={a.evidenceEventIds} events={events} />
                </li>
              ))}
            </ul>
          </DraftSection>
        </div>
      </div>
      {out.openQuestions.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Open questions for the reviewer</p>
          <ul className="mt-1 list-disc pl-5 text-zinc-300">
            {out.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {!published && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <Button
            disabled={busy || selected.size === 0}
            onClick={() => run(() => post(`${base}/${latest.id}/apply`, { sections: [...selected] }), () => {
              setSelected(new Set());
              onApplied();
            })}
          >
            Apply {selected.size ? `${selected.size} section${selected.size === 1 ? "" : "s"}` : "selected"}
          </Button>
          <span className="text-xs text-zinc-500">Replaces the chosen sections&apos; text (action items are appended). Save your edits first.</span>
          <span className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={generate}>
            Regenerate
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => run(() => post(`${base}/${latest.id}/discard`))}>
            Discard
          </Button>
        </div>
      )}
    </Card>
  );
}
