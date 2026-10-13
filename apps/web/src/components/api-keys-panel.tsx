"use client";

import { useState, type FormEvent } from "react";
import { API_URL, post } from "@/lib/api";
import { dateTime, timeAgo, timeUntil } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { useNow } from "@/lib/use-now";
import type { ApiKey, NewApiKey, Service } from "@/lib/types";
import { Button, cx, ErrorState, inputClass, Loading } from "./ui";

const GRACE_OPTIONS = [
  { label: "Old key stops now", minutes: 0 },
  { label: "Old key works 1 more hour", minutes: 60 },
  { label: "Old key works 24 more hours", minutes: 24 * 60 },
  { label: "Old key works 7 more days", minutes: 7 * 24 * 60 },
];

const STATE_STYLE: Record<ApiKey["state"], string> = {
  active: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  expiring: "bg-amber-500/15 text-amber-200 ring-amber-500/40",
  expired: "bg-zinc-700/40 text-zinc-400 ring-zinc-600",
  revoked: "bg-red-500/15 text-red-300 ring-red-500/40",
};

export function curlExample(key: string, slug: string) {
  return `curl -X POST ${API_URL}/api/v1/alerts \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"service":"${slug}","severity":"CRITICAL","title":"Checkout error rate exceeded threshold","description":"Error rate reached 38%","source":"prometheus","deduplicationKey":"checkout-errors","metadata":{"errorRate":38}}'`;
}

// The plaintext key exists only in this banner: it came back from the
// create/rotate call and is never retrievable again.
export function NewKeyBanner({ apiKey, service, onDone }: { apiKey: NewApiKey; service: Pick<Service, "name" | "slug">; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      <p className="font-medium text-amber-200">
        New API key for {service.name} — copy it now. Only its hash is stored, so it can&apos;t be shown again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-zinc-950 px-2 py-1 text-zinc-100">{apiKey.key}</code>
        <Button variant="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs text-zinc-300">{curlExample(apiKey.key, service.slug)}</pre>
      <Button variant="ghost" onClick={onDone}>
        I&apos;ve stored it
      </Button>
    </div>
  );
}

export function ApiKeysPanel({ service, onChange }: { service: Service; onChange?: () => void }) {
  const now = useNow(5000);
  const keys = useApi<{ keys: ApiKey[] }>(`/services/${service.id}/keys`);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<NewApiKey | null>(null);
  const [rotating, setRotating] = useState<number | null>(null);
  const [grace, setGrace] = useState(60);
  const [name, setName] = useState("");
  const [rateLimit, setRateLimit] = useState(120);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      keys.reload();
      onChange?.(); // e.g. refresh the services list's active-key count
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rotate = (key: ApiKey) =>
    run(async () => {
      const res = await post<{ apiKey: NewApiKey }>(`/services/${service.id}/keys/${key.id}/rotate`, { graceMinutes: grace });
      setFresh(res.apiKey);
      setRotating(null);
    });

  const revoke = (key: ApiKey) => {
    if (!window.confirm(`Revoke ${key.prefix}… now? Anything still using it will get 401 immediately.`)) return;
    run(() => post(`/services/${service.id}/keys/${key.id}/revoke`).then(() => undefined));
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const res = await post<{ apiKey: NewApiKey }>(`/services/${service.id}/keys`, {
        name: name || "Default",
        rateLimitPerMinute: rateLimit,
      });
      setFresh(res.apiKey);
      setName("");
    });
  };

  return (
    <div className="space-y-3">
      {fresh && <NewKeyBanner apiKey={fresh} service={service} onDone={() => setFresh(null)} />}
      {error && <ErrorState message={error} />}
      {keys.error ? (
        <ErrorState message={keys.error} onRetry={keys.reload} />
      ) : keys.loading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="pb-2 pr-3 font-medium">Key</th>
                <th className="pb-2 pr-3 font-medium">State</th>
                <th className="pb-2 pr-3 font-medium">Rate limit</th>
                <th className="pb-2 pr-3 font-medium">Last used</th>
                <th className="pb-2 pr-3 font-medium">Created</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {keys.data!.keys.map((k) => (
                <tr key={k.id} className={cx(k.state !== "active" && k.state !== "expiring" && "opacity-60")}>
                  <td className="py-2 pr-3">
                    <code className="text-zinc-100">{k.prefix}…</code>
                    <div className="text-xs text-zinc-500">{k.name}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={cx("rounded px-1.5 py-0.5 text-xs font-medium ring-1", STATE_STYLE[k.state])}>{k.state}</span>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {k.state === "expiring" && k.expires_at && `rotated, stops ${timeUntil(k.expires_at, now)}`}
                      {k.state === "expired" && k.expires_at && `expired ${timeAgo(k.expires_at, now)}`}
                      {k.state === "revoked" && k.revoked_at && `${timeAgo(k.revoked_at, now)}${k.revoked_by_name ? ` by ${k.revoked_by_name}` : ""}`}
                    </div>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-zinc-400">{k.rate_limit_per_minute}/min</td>
                  <td className="py-2 pr-3 text-zinc-400" title={k.last_used_at ? dateTime(k.last_used_at) : undefined}>
                    {k.last_used_at ? timeAgo(k.last_used_at, now) : "never"}
                  </td>
                  <td className="py-2 pr-3 text-zinc-400" title={dateTime(k.created_at)}>
                    {timeAgo(k.created_at, now)}
                    {k.created_by_name && <span className="text-zinc-500"> by {k.created_by_name}</span>}
                  </td>
                  <td className="space-x-2 whitespace-nowrap py-2 text-right">
                    {k.state === "active" &&
                      (rotating === k.id ? (
                        <>
                          <select className={cx(inputClass, "inline-block max-w-56")} value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
                            {GRACE_OPTIONS.map((o) => (
                              <option key={o.minutes} value={o.minutes}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <Button disabled={busy} onClick={() => rotate(k)}>
                            Rotate
                          </Button>
                          <Button variant="ghost" onClick={() => setRotating(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" onClick={() => setRotating(k.id)}>
                          Rotate…
                        </Button>
                      ))}
                    {(k.state === "active" || k.state === "expiring") && (
                      <Button variant="danger" disabled={busy} onClick={() => revoke(k)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={create} className="flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-3">
        <label className="space-y-1 text-xs text-zinc-400">
          <span>New key name</span>
          <input className={cx(inputClass, "max-w-48")} placeholder="e.g. Grafana" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>Rate limit / min</span>
          <input
            className={cx(inputClass, "max-w-28")}
            type="number"
            min={1}
            max={100000}
            value={rateLimit}
            onChange={(e) => setRateLimit(Number(e.target.value))}
          />
        </label>
        <Button type="submit" disabled={busy}>
          Create key
        </Button>
      </form>
    </div>
  );
}
