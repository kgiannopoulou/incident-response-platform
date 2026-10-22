"use client";

import { useEffect, useState } from "react";
import { Button, Card, Empty, ErrorState, Loading, cx } from "@/components/ui";
import { apiFetch, post } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useNow } from "@/lib/use-now";

type QueueInfo = { name: string; counts: Record<"waiting" | "active" | "delayed" | "failed" | "completed" | "paused", number> };
type WorkerInfo = { id: string; startedAt: string; lastSeenAt: string; processed: number; failed: number; deadLettered: number };
type DeadLetter = {
  id: string;
  queue: string;
  name: string;
  jobId: string | null;
  data: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
};

type Ingestion = {
  windowSeconds: number;
  coveredSeconds: number;
  count: number;
  perSecond: number;
  errors: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number } | null;
  decisions: Record<string, number>;
  sinceStart: { count: number; errors: number; startedAt: string };
} | null;

const QUEUE_HELP: Record<string, string> = {
  notifications: "Email pages — 5 attempts, exponential backoff (2 s → 16 s)",
  escalations: "incident-created + delayed escalation steps",
  webhooks: "Signed incident events — 5 attempts, 5 s → 40 s",
  "ai-drafts": "AI postmortem drafts — 3 attempts, 15 s → 30 s",
  investigations: "Incident investigations (agent or rules) — 3 attempts, 15 s → 30 s",
  "dead-letter": "Jobs that used up every retry, kept for review",
};

// Operations view: are the workers alive, is anything piling up, and what
// failed for good. Polls every 5 s (queue counts aren't pushed over SSE).
export default function SystemPage() {
  const user = useUser();
  const now = useNow(5000);
  const queues = useApi<{ queues: QueueInfo[]; workers: WorkerInfo[] }>(user?.role === "admin" ? "/admin/queues" : null);
  const dead = useApi<{ entries: DeadLetter[] }>(user?.role === "admin" ? "/admin/dead-letter" : null);
  const ingestion = useApi<Ingestion>(user?.role === "admin" ? "/admin/ingestion" : null);
  const [error, setError] = useState<string | null>(null);
  const { reload: reloadQueues } = queues;
  const { reload: reloadDead } = dead;
  const { reload: reloadIngestion } = ingestion;

  useEffect(() => {
    const timer = setInterval(() => {
      reloadQueues();
      reloadDead();
      reloadIngestion();
    }, 5000);
    return () => clearInterval(timer);
  }, [reloadQueues, reloadDead, reloadIngestion]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reloadQueues();
      reloadDead();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (user && user.role !== "admin") return <ErrorState message="The System page is for admins." />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">System</h1>
        <p className="text-sm text-zinc-400">
          Background jobs (BullMQ on Redis). The API never waits for a page to be sent — it saves the incident and queues a job.
        </p>
      </div>
      {error && <ErrorState message={error} />}

      <IngestionCard data={ingestion.data ?? null} />

      {queues.error ? (
        <ErrorState message={queues.error} onRetry={queues.reload} />
      ) : queues.loading ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {queues.data!.queues.map((q) => (
              <Card key={q.name} title={<code>{q.name}</code>}>
                <p className="mb-3 text-xs text-zinc-500">{QUEUE_HELP[q.name]}</p>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {(["waiting", "active", "delayed", "failed", "completed", "paused"] as const).map((state) => (
                    <div key={state} className="rounded bg-zinc-950/60 py-1.5">
                      <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{state}</dt>
                      <dd
                        className={cx(
                          "font-mono text-lg",
                          q.counts[state] > 0 && (state === "failed" || q.name === "dead-letter") ? "text-red-300" : "text-zinc-100"
                        )}
                      >
                        {q.counts[state]}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            ))}
          </div>

          <Card title={`Workers (${queues.data!.workers.length} online)`}>
            {queues.data!.workers.length === 0 ? (
              <p className="text-sm text-amber-300">
                No worker is running. Alerts are still accepted and incidents opened; pages wait in Postgres until a worker starts
                (<code>npm run dev:worker</code>).
              </p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2 font-medium">Worker</th>
                    <th className="pb-2 font-medium">Up since</th>
                    <th className="pb-2 font-medium">Last heartbeat</th>
                    <th className="pb-2 text-right font-medium">Processed</th>
                    <th className="pb-2 text-right font-medium">Failed attempts</th>
                    <th className="pb-2 text-right font-medium">Dead-lettered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {queues.data!.workers.map((w) => (
                    <tr key={w.id}>
                      <td className="py-2 font-mono text-xs">
                        <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500" />
                        {w.id}
                      </td>
                      <td className="py-2 text-zinc-400">{timeAgo(w.startedAt, now)}</td>
                      <td className="py-2 text-zinc-400">{timeAgo(w.lastSeenAt, now)}</td>
                      <td className="py-2 text-right font-mono">{w.processed}</td>
                      <td className="py-2 text-right font-mono">{w.failed}</td>
                      <td className="py-2 text-right font-mono">{w.deadLettered}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <Card title="Dead-letter queue">
        {dead.error ? (
          <ErrorState message={dead.error} onRetry={dead.reload} />
        ) : dead.loading ? (
          <Loading />
        ) : dead.data!.entries.length === 0 ? (
          <Empty>Nothing has failed for good. Jobs land here after their last retry.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {dead.data!.entries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="text-zinc-100">
                    <code className="text-xs text-zinc-400">{d.queue}</code> · {d.name}{" "}
                    <code className="text-xs text-zinc-500">{JSON.stringify(d.data)}</code>
                  </p>
                  <p className="text-red-300">{d.failedReason}</p>
                  <p className="text-xs text-zinc-500">
                    gave up after {d.attemptsMade} attempts · {timeAgo(d.failedAt, now)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => act(() => post(`/admin/dead-letter/${d.id}/retry`))}>
                    Retry
                  </Button>
                  <Button variant="ghost" onClick={() => act(() => apiFetch(`/admin/dead-letter/${d.id}`, { method: "DELETE" }))}>
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// Alert ingestion as this API process measured it (lib/ingestion-stats.ts):
// throughput and latency of POST /alerts over the last 5 minutes.
function IngestionCard({ data }: { data: Ingestion }) {
  const tiles: [string, string][] = data
    ? [
        ["Alerts (5 min)", String(data.count)],
        ["Throughput", `${data.perSecond}/s`],
        ["p50", data.latencyMs ? `${data.latencyMs.p50} ms` : "–"],
        ["p95", data.latencyMs ? `${data.latencyMs.p95} ms` : "–"],
        ["p99", data.latencyMs ? `${data.latencyMs.p99} ms` : "–"],
        ["5xx", String(data.errors)],
      ]
    : [];
  return (
    <Card title="Alert ingestion">
      <p className="mb-3 text-xs text-zinc-500">
        <code>POST /api/v1/alerts</code> latency from arrival to response, measured by this API process. Load-test it with{" "}
        <code>npm run loadtest</code>.
      </p>
      {!data ? (
        <Empty>No data yet.</Empty>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-center md:grid-cols-6">
            {tiles.map(([label, value]) => (
              <div key={label} className="rounded bg-zinc-950/60 py-1.5">
                <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
                <dd className={cx("font-mono text-lg", label === "5xx" && data.errors > 0 ? "text-red-300" : "text-zinc-100")}>{value}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(data.decisions).length > 0 && (
            <p className="mt-3 text-xs text-zinc-400">
              {Object.entries(data.decisions)
                .sort((a, b) => b[1] - a[1])
                .map(([decision, n]) => `${decision} ${n}`)
                .join(" · ")}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
