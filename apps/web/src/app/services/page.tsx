"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, ErrorState, inputClass, Loading, ServiceStatusPill } from "@/components/ui";
import { API_URL, patch, post } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import type { Service } from "@/lib/types";

type Policy = { id: number; name: string; rules: { level: number; delayMinutes: number; target: string }[] };

function curlExample(key: string) {
  return `curl -X POST ${API_URL}/api/v1/alerts \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"summary":"Checkout 5xx above 5%","severity":"critical","source":"prometheus"}'`;
}

export default function ServicesPage() {
  const user = useUser();
  const isAdmin = user?.role === "admin";
  const services = useApi<{ services: Service[] }>("/services", (e) => e.type === "service.updated" || e.type.startsWith("incident."));
  const policies = useApi<{ policies: Policy[] }>("/escalation-policies");
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ service: string; key: string } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [policyId, setPolicyId] = useState("");

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      services.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await post<{ service: Service; integrationKey: string }>("/services", {
        name,
        description,
        escalationPolicyId: policyId ? Number(policyId) : null,
      });
      setNewKey({ service: res.service.name, key: res.integrationKey });
      setName("");
      setDescription("");
    });
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Services</h1>
      {error && <ErrorState message={error} />}

      {newKey && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-200">
            Integration key for {newKey.service} — copy it now, it won&apos;t be shown again.
          </p>
          <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs text-zinc-200">{curlExample(newKey.key)}</pre>
          <Button variant="ghost" onClick={() => setNewKey(null)}>
            Done
          </Button>
        </div>
      )}

      <Card>
        {services.error ? (
          <ErrorState message={services.error} onRetry={services.reload} />
        ) : services.loading ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Team</th>
                  <th className="pb-2 pr-3 font-medium">Escalation policy</th>
                  <th className="pb-2 pr-3 font-medium">Last alert</th>
                  {isAdmin && <th className="pb-2 font-medium" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {services.data!.services.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-zinc-100">{s.name}</div>
                      <div className="text-xs text-zinc-500">
                        {s.description}
                        {s.auto_resolve && " · auto-resolves"}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <ServiceStatusPill status={s.status} />
                      {s.open_incidents > 0 && <span className="ml-2 text-xs text-zinc-500">{s.open_incidents} open</span>}
                    </td>
                    <td className="py-2 pr-3 text-zinc-400">{s.team_name ?? "—"}</td>
                    <td className="py-2 pr-3 text-zinc-400">{s.escalation_policy_name ?? "none"}</td>
                    <td className="py-2 pr-3 text-zinc-400">{timeAgo(s.last_alert_at)}</td>
                    {isAdmin && (
                      <td className="space-x-2 whitespace-nowrap py-2 text-right">
                        <Button
                          variant="ghost"
                          onClick={() => run(() => patch(`/services/${s.id}`, { maintenance: s.status !== "maintenance" }))}
                        >
                          {s.status === "maintenance" ? "End maintenance" : "Maintenance"}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            run(async () => {
                              const res = await post<{ integrationKey: string }>(`/services/${s.id}/rotate-key`);
                              setNewKey({ service: s.name, key: res.integrationKey });
                            })
                          }
                        >
                          Rotate key
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Escalation policies">
          {policies.error ? (
            <ErrorState message={policies.error} onRetry={policies.reload} />
          ) : policies.loading ? (
            <Loading />
          ) : (
            <ul className="space-y-3 text-sm">
              {policies.data!.policies.map((p) => (
                <li key={p.id}>
                  <p className="font-medium text-zinc-200">{p.name}</p>
                  <ol className="mt-1 space-y-0.5 text-zinc-400">
                    {p.rules.map((r) => (
                      <li key={r.level}>
                        L{r.level}: {r.target}
                        {r.level > 1 && <span className="text-zinc-500"> — after {r.delayMinutes} min unacknowledged</span>}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {isAdmin && (
          <Card title="Add a service">
            <form onSubmit={handleCreate} className="space-y-3">
              <input className={inputClass} placeholder="Name, e.g. Search API" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
              <input className={inputClass} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
              <select className={inputClass} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                <option value="">No escalation policy</option>
                {policies.data?.policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button type="submit">Create service</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
