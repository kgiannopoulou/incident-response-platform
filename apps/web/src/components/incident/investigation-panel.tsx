"use client";

import { useState } from "react";
import type { EvidenceItem, Hypothesis, InvestigationFindings } from "@irp/shared";
import { Button, Card, cx } from "@/components/ui";
import { post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { Investigation } from "@/lib/types";

// The AI Incident Investigator on the incident page. One click collects the
// evidence around the incident — alerts, deployments, error-log patterns,
// dependencies, other incidents — and returns ranked hypotheses, each with
// the evidence for and against it, plus a reconstructed timeline. Every
// chip is a real item the investigator retrieved (hover for the detail);
// citations it couldn't back up were removed before you see them.
//
// It only suggests: "Post to timeline" turns a hypothesis into your own
// note, marked unconfirmed. The investigator itself can't change anything.

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const KIND_ICON: Record<string, string> = {
  deployment: "🚀",
  alert: "🔔",
  log: "📜",
  incident: "🔥",
  related: "🔗",
  event: "🕑",
  action: "👤",
  service: "🧩",
};

const CONFIDENCE_STYLE: Record<Hypothesis["confidence"], string> = {
  high: "bg-violet-500/20 text-violet-200 ring-violet-500/50",
  medium: "bg-sky-500/15 text-sky-200 ring-sky-500/40",
  low: "bg-zinc-700/40 text-zinc-300 ring-zinc-600",
};

function EvidenceChips({ ids, evidence, tone }: { ids: string[]; evidence: Record<string, EvidenceItem>; tone: "for" | "against" }) {
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className={cx("mr-1 text-[10px] font-semibold uppercase tracking-wide", tone === "for" ? "text-emerald-400" : "text-red-400")}>
        {tone === "for" ? "Evidence" : "Against"}
      </span>
      {ids.map((id) => {
        const e = evidence[id];
        return (
          <span
            key={id}
            title={e ? `${e.at ? `${clock(e.at)} · ` : ""}${e.service ?? ""}\n${e.summary}` : id}
            className={cx(
              "max-w-[18rem] truncate rounded px-1.5 py-0.5 font-mono text-[10px] ring-1",
              tone === "for" ? "bg-emerald-500/10 text-emerald-200 ring-emerald-500/30" : "bg-red-500/10 text-red-200 ring-red-500/30"
            )}
          >
            {KIND_ICON[e?.kind ?? ""] ?? "•"} {e ? `${e.at ? `${clock(e.at).slice(0, 5)} ` : ""}${e.summary}` : id}
          </span>
        );
      })}
    </div>
  );
}

function HypothesisCard(props: {
  h: Hypothesis;
  rank: number;
  evidence: Record<string, EvidenceItem>;
  canPost: boolean;
  posted: boolean;
  onPost: () => void;
}) {
  const { h, rank, evidence, canPost, posted, onPost } = props;
  return (
    <li className={cx("rounded-md border p-3", rank === 1 ? "border-violet-500/50 bg-violet-500/5" : "border-zinc-800")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-zinc-100">
          <span className="mr-1.5 text-zinc-500">#{rank}</span>
          {h.title}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">{h.category}</span>
          <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1", CONFIDENCE_STYLE[h.confidence])}>
            {h.confidence}
            {h.score !== undefined && ` · ${Math.round(h.score * 100)}%`}
          </span>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-300">{h.statement}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{h.reasoning}</p>
      <div className="mt-2 space-y-1">
        <EvidenceChips ids={h.supportingEvidence} evidence={evidence} tone="for" />
        <EvidenceChips ids={h.contradictingEvidence} evidence={evidence} tone="against" />
      </div>
      {h.nextChecks.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-300">
          {h.nextChecks.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {canPost && (
        <div className="mt-2 text-right">
          <Button variant="ghost" className="px-2 py-1 text-xs" disabled={posted} onClick={onPost}>
            {posted ? "Posted to timeline" : "Post to timeline"}
          </Button>
        </div>
      )}
    </li>
  );
}

export function InvestigationPanel({ number, canAct }: { number: number; canAct: boolean }) {
  const list = useApi<{ investigations: Investigation[] }>(
    `/incidents/${number}/investigations`,
    (e) => e.type === "investigation.updated" && e.number === number
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<Set<string>>(new Set());
  const latest = list.data?.investigations[0] ?? null;
  const running = latest?.status === "queued" || latest?.status === "running";

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await post(`/incidents/${number}/investigations`);
      list.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function postHypothesis(inv: Investigation, h: Hypothesis) {
    setError(null);
    try {
      await post(`/incidents/${number}/investigations/${inv.id}/hypotheses/${h.id}/post`);
      setPosted((s) => new Set(s).add(`${inv.id}:${h.id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const providerLabel = (inv: Investigation) =>
    inv.provider === "claude" ? `AI agent · ${inv.model ?? "Claude"}` : inv.provider === "rules" ? "Offline correlation rules (not AI)" : null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          🔎 Investigation
          {latest?.status === "completed" && <span className="text-xs font-normal text-zinc-500">{providerLabel(latest)}</span>}
        </span>
      }
      actions={
        <Button variant={latest ? "ghost" : "primary"} className="px-2.5 py-1 text-xs" disabled={busy || running} onClick={start}>
          {running ? "Investigating…" : latest ? "Re-run" : "Investigate"}
        </Button>
      }
    >
      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
      {list.error && <p className="text-sm text-red-300">{list.error}</p>}
      {!latest && !list.loading && (
        <p className="text-sm text-zinc-400">
          Correlate this incident with what changed (deployments), new error patterns in the logs, failing dependencies and other open
          incidents, and get ranked, evidence-backed hypotheses with a reconstructed timeline.
        </p>
      )}
      {running && (
        <p className="flex items-center gap-2 text-sm text-violet-200">
          <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
          Gathering alerts, deployments, logs and dependencies… (started {timeAgo(latest!.created_at)})
        </p>
      )}
      {latest?.status === "failed" && <p className="text-sm text-red-300">Investigation failed: {latest.error}</p>}
      {latest?.status === "completed" && latest.findings && (
        <Findings
          inv={latest}
          findings={latest.findings}
          canPost={canAct}
          posted={posted}
          onPost={(h) => postHypothesis(latest, h)}
        />
      )}
    </Card>
  );
}

function Findings(props: { inv: Investigation; findings: InvestigationFindings; canPost: boolean; posted: Set<string>; onPost: (h: Hypothesis) => void }) {
  const { inv, findings, canPost, posted, onPost } = props;
  const evidence = inv.evidence ?? {};
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-200">{findings.summary}</p>

      <ol className="space-y-2">
        {findings.hypotheses.map((h, i) => (
          <HypothesisCard key={h.id} h={h} rank={i + 1} evidence={evidence} canPost={canPost} posted={posted.has(`${inv.id}:${h.id}`)} onPost={() => onPost(h)} />
        ))}
      </ol>

      {findings.timeline.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Reconstructed timeline</h3>
          <ol className="space-y-0.5 border-l border-zinc-800 pl-3 text-xs">
            {findings.timeline.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-16 shrink-0 font-mono text-zinc-500">{clock(e.at)}</span>
                <span aria-hidden>{KIND_ICON[e.kind] ?? "•"}</span>
                <span className={cx("text-zinc-300", e.kind === "deployment" && "font-medium text-zinc-100")}>{e.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {findings.openQuestions.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Open questions</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-300">
            {findings.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {inv.warnings.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          {inv.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer select-none">
          How it got there: {inv.steps.length} step(s), {Object.keys(evidence).length} evidence items
          {inv.completed_at && inv.started_at && ` · ${Math.max(1, Math.round((Date.parse(inv.completed_at) - Date.parse(inv.started_at)) / 1000))} s`}
        </summary>
        <ol className="mt-1.5 space-y-0.5 font-mono">
          {inv.steps.map((s, i) => (
            <li key={i} className={s.error ? "text-red-300" : undefined}>
              {i + 1}. {s.tool}({Object.entries(s.input ?? {}).filter(([, v]) => v !== null && typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(", ")}) → {s.error ?? `${s.results} result(s)`}
            </li>
          ))}
        </ol>
      </details>
      <p className="text-[11px] text-zinc-500">
        Suggestions to verify, not conclusions. The investigator reads evidence and can&apos;t change this incident; posting a hypothesis adds it
        to the timeline as your note, marked unconfirmed.
      </p>
    </div>
  );
}
