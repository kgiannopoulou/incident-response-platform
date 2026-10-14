"use client";

import { Fragment, useState, type FormEvent } from "react";
import { describeEscalationDelay, type EscalationTargetType } from "@irp/shared";
import { Button, Card, Empty, ErrorState, inputClass, Loading } from "@/components/ui";
import { apiFetch, post, put } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import type { EscalationPolicy } from "@/lib/types";

type Person = { id: number; name: string };
type DraftStep = { delayMinutes: number; targets: { targetType: EscalationTargetType; targetId: number }[] };
type Draft = { id: number | null; name: string; description: string; steps: DraftStep[] };

const EMPTY_DRAFT: Draft = { id: null, name: "", description: "", steps: [{ delayMinutes: 0, targets: [] }] };

// One policy drawn as the chain responders think in:
//   0 min ↓ Notify Backend Team ↓ 5 min without acknowledgement ↓ Notify Team Lead
function PolicyChain({ policy }: { policy: EscalationPolicy }) {
  return (
    <ol className="space-y-1">
      {policy.steps.map((step, i) => (
        <Fragment key={step.position}>
          {i > 0 && <li aria-hidden className="pl-[4.25rem] text-zinc-600">↓</li>}
          <li className="flex items-start gap-3">
            <span className="w-14 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-center font-mono text-xs text-zinc-300">
              {step.delayMinutes} min
            </span>
            <div>
              <p className="text-xs text-zinc-500">
                L{step.position} · {describeEscalationDelay(step.delayMinutes)}
              </p>
              <p className="text-sm text-zinc-100">
                Notify{" "}
                {step.targets.map((t, j) => (
                  <Fragment key={`${t.targetType}-${t.targetId}`}>
                    {j > 0 && ", "}
                    <span className={t.targetType === "team" ? "text-sky-300" : undefined}>
                      {t.targetType === "team" ? `${t.name} team` : t.name}
                    </span>
                  </Fragment>
                ))}
              </p>
            </div>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function PolicyEditor({
  draft,
  setDraft,
  users,
  teams,
  onSaved,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  users: Person[];
  teams: Person[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateStep = (i: number, step: DraftStep) => setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? step : s)) });
  const nameOf = (t: DraftStep["targets"][number]) =>
    (t.targetType === "team" ? teams : users).find((p) => p.id === t.targetId)?.name ?? "?";

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = { name: draft.name, description: draft.description, steps: draft.steps };
      if (draft.id) await put(`/escalation-policies/${draft.id}`, body);
      else await post("/escalation-policies", body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      {error && <ErrorState message={error} />}
      <input className={inputClass} placeholder="Policy name, e.g. Checkout escalation" value={draft.name} required minLength={2} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <input className={inputClass} placeholder="Description (optional)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />

      <ol className="space-y-3">
        {draft.steps.map((step, i) => (
          <li key={i} className="rounded-md border border-zinc-800 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-zinc-200">Step {i + 1}</span>
              <span className="text-zinc-500">after</span>
              <input
                type="number"
                min={0}
                max={1440}
                aria-label={`Step ${i + 1} delay in minutes`}
                className={`${inputClass} w-20`}
                value={step.delayMinutes}
                onChange={(e) => updateStep(i, { ...step, delayMinutes: Number(e.target.value) })}
              />
              <span className="text-zinc-500">min unacknowledged</span>
              {draft.steps.length > 1 && (
                <button type="button" className="ml-auto text-xs text-zinc-500 hover:text-red-300" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}>
                  Remove step
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {step.targets.map((t) => (
                <span key={`${t.targetType}-${t.targetId}`} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200">
                  {t.targetType === "team" ? `${nameOf(t)} team` : nameOf(t)}
                  <button
                    type="button"
                    aria-label="Remove target"
                    className="text-zinc-500 hover:text-zinc-100"
                    onClick={() => updateStep(i, { ...step, targets: step.targets.filter((x) => x !== t) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              <select
                aria-label={`Add a target to step ${i + 1}`}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-300"
                value=""
                onChange={(e) => {
                  const [targetType, id] = e.target.value.split(":");
                  const target = { targetType: targetType as EscalationTargetType, targetId: Number(id) };
                  if (!step.targets.some((t) => t.targetType === target.targetType && t.targetId === target.targetId)) {
                    updateStep(i, { ...step, targets: [...step.targets, target] });
                  }
                }}
              >
                <option value="">+ Add target…</option>
                <optgroup label="Teams">
                  {teams.map((t) => (
                    <option key={t.id} value={`team:${t.id}`}>
                      {t.name} team
                    </option>
                  ))}
                </optgroup>
                <optgroup label="People">
                  {users.map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={draft.steps.length >= 10}
          onClick={() => {
            const last = draft.steps[draft.steps.length - 1];
            setDraft({ ...draft, steps: [...draft.steps, { delayMinutes: (last?.delayMinutes ?? 0) + 5, targets: [] }] });
          }}
        >
          + Add step
        </Button>
        <Button type="submit" disabled={saving} className="ml-auto">
          {draft.id ? "Save policy" : "Create policy"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function EscalationPoliciesPage() {
  const user = useUser();
  const isAdmin = user?.role === "admin";
  const policies = useApi<{ policies: EscalationPolicy[] }>("/escalation-policies");
  const users = useApi<{ users: Person[] }>(isAdmin ? "/users" : null);
  const teams = useApi<{ teams: Person[] }>(isAdmin ? "/teams" : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = (p: EscalationPolicy) =>
    setDraft({
      id: p.id,
      name: p.name,
      description: p.description,
      steps: p.steps.map((s) => ({ delayMinutes: s.delayMinutes, targets: s.targets.map(({ targetType, targetId }) => ({ targetType, targetId })) })),
    });

  async function remove(p: EscalationPolicy) {
    setError(null);
    try {
      await apiFetch(`/escalation-policies/${p.id}`, { method: "DELETE" });
      policies.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Escalation policies</h1>
          <p className="text-sm text-zinc-400">
            Who gets paged while an incident stays unacknowledged. Delays count from when the incident triggered; acknowledging stops the chain.
          </p>
        </div>
        {isAdmin && !draft && <Button onClick={() => setDraft(EMPTY_DRAFT)}>New policy</Button>}
      </div>
      {error && <ErrorState message={error} />}

      {draft && (
        <Card title={draft.id ? `Edit ${draft.name}` : "New escalation policy"}>
          <PolicyEditor
            draft={draft}
            setDraft={setDraft}
            users={users.data?.users ?? []}
            teams={teams.data?.teams ?? []}
            onCancel={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              policies.reload();
            }}
          />
        </Card>
      )}

      {policies.error ? (
        <ErrorState message={policies.error} onRetry={policies.reload} />
      ) : policies.loading ? (
        <Loading />
      ) : policies.data!.policies.length === 0 ? (
        <Empty>No escalation policies yet.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {policies.data!.policies.map((p) => (
            <Card
              key={p.id}
              title={p.name}
              actions={
                isAdmin && (
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => edit(p)}>
                      Edit
                    </Button>
                    <Button variant="ghost" disabled={p.services.length > 0} title={p.services.length ? "Assigned to services" : undefined} onClick={() => remove(p)}>
                      Delete
                    </Button>
                  </div>
                )
              }
            >
              {p.description && <p className="mb-3 text-sm text-zinc-400">{p.description}</p>}
              <PolicyChain policy={p} />
              <p className="mt-4 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
                Used by: {p.services.length ? p.services.map((s) => s.name).join(", ") : "no services"}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
