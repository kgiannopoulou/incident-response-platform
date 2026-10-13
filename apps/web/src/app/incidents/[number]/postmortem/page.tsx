"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { INCIDENT_SEVERITY_LABEL, incidentRef } from "@irp/shared";
import { Button, Card, cx, ErrorState, inputClass, Loading } from "@/components/ui";
import { post, put } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { Postmortem } from "@/lib/types";

type Draft = Pick<Postmortem, "summary" | "impact" | "root_cause" | "resolution" | "action_items">;

const SECTIONS: { key: keyof Omit<Draft, "action_items">; title: string; hint: string }[] = [
  { key: "summary", title: "Summary", hint: "What happened, in two or three sentences." },
  { key: "impact", title: "Impact", hint: "Who was affected and how badly." },
  { key: "root_cause", title: "Root cause", hint: "Why it happened — the confirmed cause and contributing factors." },
  { key: "resolution", title: "Resolution", hint: "How it was mitigated and fixed." },
];

export default function PostmortemPage() {
  const number = Number(useParams<{ number: string }>().number);
  const pm = useApi<{ postmortem: Postmortem }>(`/incidents/${number}/postmortem`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Seed the editable copy whenever a new server copy arrives (first load,
  // or the reload after a save) — React's "adjust state while rendering"
  // pattern, rather than an effect.
  const [seededFrom, setSeededFrom] = useState<unknown>(null);
  if (pm.data && pm.data !== seededFrom) {
    const p = pm.data.postmortem;
    setSeededFrom(pm.data);
    setDraft({ summary: p.summary, impact: p.impact, root_cause: p.root_cause, resolution: p.resolution, action_items: p.action_items });
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

  async function save(status?: "draft" | "published") {
    setSaving(true);
    setMessage(null);
    try {
      await put(`/incidents/${number}/postmortem`, {
        summary: draft!.summary,
        impact: draft!.impact,
        rootCause: draft!.root_cause,
        resolution: draft!.resolution,
        actionItems: draft!.action_items.filter((a) => a.description.trim()),
        ...(status ? { status } : {}),
      });
      setMessage({ kind: "ok", text: status === "published" ? "Published." : "Saved." });
      pm.reload();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    setSaving(true);
    try {
      await post(`/incidents/${number}/postmortem`);
      pm.reload();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const setItem = (i: number, patch: Partial<Draft["action_items"][number]>) =>
    setDraft({ ...draft, action_items: draft.action_items.map((a, j) => (i === j ? { ...a, ...patch } : a)) });

  const m = p.metrics;
  return (
    <div className="space-y-5">
      <div className="text-sm text-zinc-500">
        <Link href={`/incidents/${number}`} className="hover:underline">
          {incidentRef(number)}
        </Link>{" "}
        / Postmortem
      </div>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Postmortem: {p.title}</h1>
          <p className="text-sm text-zinc-400">
            {INCIDENT_SEVERITY_LABEL[p.severity]} · {p.service_name ?? "no service"} ·{" "}
            <span className={cx("capitalize", p.status === "published" ? "text-emerald-400" : "text-amber-300")}>{p.status}</span> · updated{" "}
            {timeAgo(p.updated_at)}
            {p.updated_by_name && ` by ${p.updated_by_name}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={regenerate} disabled={saving} title="Refresh metrics and timeline; your text is kept">
            Refresh data
          </Button>
          <Button variant="ghost" onClick={() => save()} disabled={saving}>
            Save draft
          </Button>
          <Button variant="success" onClick={() => save("published")} disabled={saving}>
            Publish
          </Button>
        </div>
      </header>
      {message && (message.kind === "error" ? <ErrorState message={message.text} /> : <p className="text-sm text-emerald-400">{message.text}</p>)}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          ["Time to acknowledge", duration(m.timeToAcknowledgeSeconds)],
          ["Time to resolve", duration(m.timeToResolveSeconds)],
          ["Alerts", m.alertCount],
          ["Escalations", m.escalations],
          ["Notes", m.notesCount],
          ["Responders", m.responderCount],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {SECTIONS.map((s) => (
            <Card key={s.key} title={s.title}>
              <p className="mb-2 text-xs text-zinc-500">{s.hint}</p>
              <textarea
                className={inputClass}
                rows={4}
                value={draft[s.key]}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              />
            </Card>
          ))}
          <Card
            title="Action items"
            actions={
              <Button variant="ghost" onClick={() => setDraft({ ...draft, action_items: [...draft.action_items, { description: "", owner: "", done: false }] })}>
                + Add
              </Button>
            }
          >
            <ul className="space-y-2">
              {draft.action_items.map((a, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={a.done} onChange={(e) => setItem(i, { done: e.target.checked })} aria-label="Done" />
                  <input className={inputClass} value={a.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="What needs to happen" />
                  <input className={cx(inputClass, "max-w-32")} value={a.owner} onChange={(e) => setItem(i, { owner: e.target.value })} placeholder="Owner" />
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
          </Card>
        </div>
        <Card title="Timeline (generated)">
          <ul className="space-y-2 text-sm text-zinc-300">
            {p.timeline_markdown.split("\n").filter(Boolean).map((line, i) => (
              <li key={i}>{line.replace(/^- /, "").replace(/\*\*/g, "").replace(/_\((.*)\)_/, "($1)")}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
