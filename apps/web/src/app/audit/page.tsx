"use client";

import { useState } from "react";
import { Button, Card, ErrorState, Loading } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Entry = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: number | null;
  details: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
};
type Page = { entries: Entry[]; nextBefore: number | null };

export default function AuditPage() {
  const first = useApi<Page>("/audit-log", (e) => e.type.startsWith("incident.") || e.type === "service.updated");
  const [older, setOlder] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const nextBefore = cursor === undefined ? first.data?.nextBefore : cursor;

  async function loadMore() {
    try {
      const page = await apiFetch<Page>(`/audit-log?before=${nextBefore}`);
      setOlder((prev) => [...prev, ...page.entries]);
      setCursor(page.nextBefore);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (first.error) return <ErrorState message={first.error} onRetry={first.reload} />;
  if (!first.data) return <Loading />;
  const entries = [...first.data.entries, ...older];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="text-sm text-zinc-400">Every change made through the API or by automation, written in the same transaction as the change itself.</p>
      <Card>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="pb-2 pr-3 font-medium">When</th>
              <th className="pb-2 pr-3 font-medium">Who</th>
              <th className="pb-2 pr-3 font-medium">Action</th>
              <th className="pb-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap py-1.5 pr-3 text-zinc-400">{dateTime(e.created_at)}</td>
                <td className="py-1.5 pr-3 text-zinc-300">{e.actor_name ?? "system"}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-zinc-200">{e.action}</td>
                <td className="max-w-md truncate py-1.5 font-mono text-xs text-zinc-500" title={JSON.stringify(e.details)}>
                  {e.entity_type}#{e.entity_id} {JSON.stringify(e.details)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <ErrorState message={error} onRetry={loadMore} />}
        {nextBefore && (
          <div className="mt-3 text-center">
            <Button variant="ghost" onClick={loadMore}>
              Load older
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
