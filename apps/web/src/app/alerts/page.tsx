"use client";

import { useState } from "react";
import { ALERT_SEVERITIES, ALERT_STATUSES } from "@irp/shared";
import { AlertFeed } from "@/components/alert-feed";
import { Card, cx, ErrorState, Loading } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import type { AlertRow } from "@/lib/types";

function Chips<T extends string>({ value, options, onChange }: { value: T | ""; options: readonly T[]; onChange: (v: T | "") => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {(["", ...options] as (T | "")[]).map((option) => (
        <button
          key={option || "all"}
          onClick={() => onChange(option)}
          className={cx(
            "rounded-full px-3 py-1 text-xs uppercase tracking-wide",
            value === option ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          )}
        >
          {option || "all"}
        </button>
      ))}
    </div>
  );
}

export default function AlertsPage() {
  const [severity, setSeverity] = useState<(typeof ALERT_SEVERITIES)[number] | "">("");
  const [status, setStatus] = useState<(typeof ALERT_STATUSES)[number] | "">("");
  const query = new URLSearchParams({ ...(severity ? { severity } : {}), ...(status ? { status } : {}) });
  const alerts = useApi<{ alerts: AlertRow[] }>(`/alerts?${query}`, (e) => e.type === "alert.received" || e.type === "incident.updated");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Alerts</h1>
      <p className="text-sm text-zinc-400">
        Every alert received through <code>POST /api/v1/alerts</code>, newest first. Updates live.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Chips value={severity} options={ALERT_SEVERITIES} onChange={setSeverity} />
        <Chips value={status} options={ALERT_STATUSES} onChange={setStatus} />
      </div>
      <Card>
        {alerts.error ? (
          <ErrorState message={alerts.error} onRetry={alerts.reload} />
        ) : alerts.loading ? (
          <Loading />
        ) : (
          <AlertFeed alerts={alerts.data!.alerts} detailed />
        )}
      </Card>
    </div>
  );
}
