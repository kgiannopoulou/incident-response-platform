"use client";

import Link from "next/link";
import { useState } from "react";
import { incidentRef, type DemoRunState } from "@irp/shared";
import { Button, cx } from "@/components/ui";
import { post } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { useApi } from "@/lib/use-api";

// [ ▶ Simulate production incident ] and, while it runs, a strip showing the
// scenario's steps lighting up as each alert is ingested:
//
//   ● CPU alert ─ ● API latency alert ─ ● Checkout failures ─ ○ Critical incident ─ …
//
// Progress arrives as "demo.progress" events over the live stream.

type DemoInfo = {
  enabled: boolean;
  scenario: { name: string; description: string; steps: { at: number; label: string }[] };
  run: DemoRunState | null;
};

export function SimulateButton({ onStarted }: { onStarted?: () => void }) {
  const user = useUser();
  const demo = useApi<DemoInfo>("/demo", (e) => e.type === "demo.progress");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!demo.data?.enabled || user?.role !== "admin") return null;
  const running = !!demo.data.run && !demo.data.run.done;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await post("/demo/simulate", { speed: 1 });
      demo.reload();
      onStarted?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs text-red-300">{error}</span>}
      <Button variant="ghost" onClick={start} disabled={busy || running} title={demo.data.scenario.description}>
        {running ? "Simulating…" : "▶ Simulate production incident"}
      </Button>
    </span>
  );
}

export function SimulationProgress() {
  const demo = useApi<DemoInfo>("/demo", (e) => e.type === "demo.progress");
  const run = demo.data?.run;
  if (!demo.data || !run) return null;
  const steps = demo.data.scenario.steps;

  return (
    <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-violet-100">
          {run.done ? "Simulation finished" : "Simulating"}: {demo.data.scenario.name}
          <span className="ml-2 font-normal text-violet-300/80">
            started by {run.startedBy} · step {run.step}/{run.total}
          </span>
        </p>
        <p className="text-xs text-violet-300/80">Simulated alerts are tagged metadata.simulated — respond to the incidents as usual.</p>
      </div>
      <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-2 text-xs">
        {steps.map((s, i) => {
          const result = run.results[i];
          return (
            <li key={s.label} className="flex items-center gap-1">
              {i > 0 && <span className={cx("h-px w-4", result ? "bg-violet-300" : "bg-zinc-700")} />}
              <span
                className={cx(
                  "flex items-center gap-1.5 rounded-full px-2 py-0.5",
                  result ? "bg-violet-500/25 text-violet-100" : i === run.step && !run.done ? "animate-pulse bg-zinc-800 text-zinc-300" : "bg-zinc-900 text-zinc-500"
                )}
              >
                <span className="font-mono text-[10px] opacity-70">00:{String(s.at).padStart(2, "0")}</span>
                {s.label}
                {result?.incident && (
                  <Link href={`/incidents/${result.incident}`} className="font-mono text-[10px] underline">
                    {incidentRef(result.incident)}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
