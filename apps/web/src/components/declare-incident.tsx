"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { INCIDENT_SEVERITIES, INCIDENT_SEVERITY_LABEL, type IncidentSeverity } from "@irp/shared";
import { post } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { Service } from "@/lib/types";
import { Button, ErrorState, inputClass } from "./ui";

// "Our checkout service is down." — declaring an incident by hand, for
// problems no monitor caught. The declarer becomes incident commander.
export function DeclareIncident({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const services = useApi<{ services: Service[] }>("/services");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("sev2");
  const [serviceId, setServiceId] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { incident } = await post<{ incident: { number: number } }>("/incidents", {
        title,
        severity,
        serviceId: serviceId ? Number(serviceId) : null,
        description: description || undefined,
      });
      router.push(`/incidents/${incident.number}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5"
      >
        <h2 className="text-lg font-semibold">Declare an incident</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-300">What is happening?</span>
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Our checkout service is down" required minLength={3} autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-300">Severity</span>
            <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}>
              {INCIDENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {INCIDENT_SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-300">Affected service</span>
            <select className={inputClass} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">— none —</option>
              {services.data?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-300">Details (optional)</span>
          <textarea className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? "Declaring…" : "Declare incident"}
          </Button>
        </div>
      </form>
    </div>
  );
}
