"use client";

import { useState, type FormEvent } from "react";
import { WEBHOOK_EVENTS, type WebhookEvent } from "@irp/shared";
import { Button, Card, Empty, ErrorState, inputClass, Loading, cx } from "@/components/ui";
import { apiFetch, patch, post } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Endpoint = {
  id: number;
  url: string;
  description: string;
  events: WebhookEvent[];
  enabled: boolean;
  disabled_reason: string | null;
  created_at: string;
  last_delivery: { status: string; responseStatus: number | null; at: string } | null;
  failures_24h: number;
};

type Delivery = {
  id: number;
  event: string;
  status: "queued" | "sent" | "failed";
  attempts: number;
  response_status: number | null;
  duration_ms: number | null;
  last_error: string | null;
  created_at: string;
  incident_number: number | null;
  payload: unknown;
};

const STATUS_STYLE = {
  queued: "text-zinc-400",
  sent: "text-emerald-300",
  failed: "text-red-300",
};

const SIGNATURE_EXAMPLE = `const expected = crypto
  .createHmac("sha256", secret)
  .update(\`\${t}.\${rawBody}\`)
  .digest("hex");
// Fireline-Signature: t=<unix seconds>,v1=<expected>
// reject if |now - t| > 300 s`;

function SecretBanner({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <p className="font-medium text-amber-200">Signing secret — shown once</p>
      <code className="mt-2 block break-all rounded bg-zinc-950 px-2 py-1.5 font-mono text-amber-100">{secret}</code>
      <p className="mt-2 text-zinc-400">Store it with the receiver and use it to verify the <code>Fireline-Signature</code> header.</p>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(secret)}>
          Copy
        </Button>
        <Button onClick={onDone}>I&apos;ve stored it</Button>
      </div>
    </div>
  );
}

function Deliveries({ endpointId, onError }: { endpointId: number; onError: (m: string) => void }) {
  const deliveries = useApi<{ deliveries: Delivery[] }>(`/webhooks/${endpointId}/deliveries`);
  const [open, setOpen] = useState<number | null>(null);
  if (deliveries.error) return <ErrorState message={deliveries.error} onRetry={deliveries.reload} />;
  if (deliveries.loading) return <Loading />;
  if (deliveries.data!.deliveries.length === 0) return <Empty>No deliveries yet. Send a test to check the receiver.</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={deliveries.reload}>
          Refresh
        </button>
      </div>
      <ul className="divide-y divide-zinc-800 text-sm">
        {deliveries.data!.deliveries.map((d) => (
          <li key={d.id} className="py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={cx("w-14 font-medium", STATUS_STYLE[d.status])}>{d.status}</span>
              <code className="text-xs text-zinc-300">{d.event}</code>
              {d.incident_number && <span className="text-xs text-zinc-500">INC-{d.incident_number}</span>}
              <span className="text-xs text-zinc-500">
                {d.response_status ? `HTTP ${d.response_status}` : "no response"}
                {d.duration_ms !== null && ` · ${d.duration_ms} ms`} · {d.attempts} attempt{d.attempts === 1 ? "" : "s"} · {timeAgo(d.created_at)}
              </span>
              <span className="ml-auto flex gap-3">
                <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  {open === d.id ? "Hide payload" : "Payload"}
                </button>
                {d.status !== "queued" && (
                  <button
                    className="text-xs text-zinc-400 hover:text-zinc-100"
                    onClick={() => post(`/webhooks/deliveries/${d.id}/redeliver`).then(deliveries.reload, (e) => onError(e.message))}
                  >
                    Redeliver
                  </button>
                )}
              </span>
            </div>
            {d.last_error && <p className="mt-0.5 text-xs text-red-300">{d.last_error}</p>}
            {open === d.id && (
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">{JSON.stringify(d.payload, null, 2)}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function WebhooksPage() {
  const user = useUser();
  const endpoints = useApi<{ endpoints: Endpoint[] }>(user?.role === "admin" ? "/webhooks" : null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      endpoints.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await post<{ secret: string }>("/webhooks", { url, description, events });
      setSecret(res.secret);
      setUrl("");
      setDescription("");
    });
  }

  if (user && user.role !== "admin") return <ErrorState message="Webhooks are managed by admins." />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Webhooks</h1>
        <p className="text-sm text-zinc-400">
          Incident events POSTed as signed JSON to your systems (chat bots, ticketing, status pages). Pages to people go out by email.
        </p>
      </div>
      {error && <ErrorState message={error} />}
      {secret && <SecretBanner secret={secret} onDone={() => setSecret(null)} />}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {endpoints.error ? (
            <ErrorState message={endpoints.error} onRetry={endpoints.reload} />
          ) : endpoints.loading ? (
            <Loading />
          ) : endpoints.data!.endpoints.length === 0 ? (
            <Card>
              <Empty>No endpoints yet. Add one to receive incident.triggered, acknowledged, escalated and resolved events.</Empty>
            </Card>
          ) : (
            endpoints.data!.endpoints.map((ep) => (
              <Card
                key={ep.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className={cx("h-2 w-2 rounded-full", ep.enabled ? "bg-emerald-500" : "bg-zinc-600")} />
                    <span className="break-all font-mono text-xs">{ep.url}</span>
                  </span>
                }
                actions={
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" onClick={() => run(() => post(`/webhooks/${ep.id}/test`).then(() => setExpanded(ep.id)))}>
                      Send test
                    </Button>
                    <Button variant="ghost" onClick={() => run(() => patch(`/webhooks/${ep.id}`, { enabled: !ep.enabled }))}>
                      {ep.enabled ? "Disable" : "Enable"}
                    </Button>
                  </div>
                }
              >
                {ep.description && <p className="mb-2 text-sm text-zinc-300">{ep.description}</p>}
                {ep.disabled_reason && <p className="mb-2 text-sm text-amber-300">Disabled automatically: {ep.disabled_reason}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {ep.events.map((ev) => (
                    <code key={ev} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                      {ev}
                    </code>
                  ))}
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  Last delivery:{" "}
                  {ep.last_delivery
                    ? `${ep.last_delivery.status}${ep.last_delivery.responseStatus ? ` (HTTP ${ep.last_delivery.responseStatus})` : ""} ${timeAgo(ep.last_delivery.at)}`
                    : "never"}
                  {ep.failures_24h > 0 && <span className="text-red-300"> · {ep.failures_24h} failed in 24 h</span>}
                </p>
                <div className="mt-3 flex flex-wrap gap-3 border-t border-zinc-800 pt-3 text-xs">
                  <button className="text-zinc-300 hover:text-white" onClick={() => setExpanded(expanded === ep.id ? null : ep.id)}>
                    {expanded === ep.id ? "Hide deliveries" : "Recent deliveries"}
                  </button>
                  <button
                    className="text-zinc-400 hover:text-white"
                    onClick={() => run(async () => setSecret((await post<{ secret: string }>(`/webhooks/${ep.id}/rotate-secret`)).secret))}
                  >
                    Rotate secret
                  </button>
                  <button className="ml-auto text-zinc-500 hover:text-red-300" onClick={() => run(() => apiFetch(`/webhooks/${ep.id}`, { method: "DELETE" }))}>
                    Delete
                  </button>
                </div>
                {expanded === ep.id && (
                  <div className="mt-3">
                    <Deliveries endpointId={ep.id} onError={setError} />
                  </div>
                )}
              </Card>
            ))
          )}
        </div>

        <div className="space-y-4">
          <Card title="Add an endpoint">
            <form onSubmit={create} className="space-y-3">
              <input className={inputClass} type="url" placeholder="https://hooks.example.com/fireline" value={url} onChange={(e) => setUrl(e.target.value)} required />
              <input className={inputClass} placeholder="Description, e.g. #incidents bot" value={description} onChange={(e) => setDescription(e.target.value)} />
              <fieldset className="space-y-1 text-sm">
                <legend className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Events</legend>
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={events.includes(ev)}
                      onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
                    />
                    <code className="text-xs">{ev}</code>
                  </label>
                ))}
              </fieldset>
              <Button type="submit" disabled={events.length === 0}>
                Add endpoint
              </Button>
            </form>
          </Card>
          <Card title="Verifying requests">
            <p className="mb-2 text-xs text-zinc-400">
              Every request is signed with HMAC-SHA256 over <code>timestamp.body</code>. Retries: 5 attempts, 5 s → 40 s backoff. Answer{" "}
              <code>410</code> to unsubscribe.
            </p>
            <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">{SIGNATURE_EXAMPLE}</pre>
          </Card>
        </div>
      </div>
    </div>
  );
}
