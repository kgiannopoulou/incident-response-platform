import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { IncidentSeverity, IncidentStatus, ServiceStatus } from "@irp/shared";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

const SEVERITY_STYLE: Record<IncidentSeverity, string> = {
  sev1: "bg-red-500/15 text-red-300 ring-red-500/40",
  sev2: "bg-orange-500/15 text-orange-300 ring-orange-500/40",
  sev3: "bg-amber-500/15 text-amber-200 ring-amber-500/40",
  sev4: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
};

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return (
    <span className={cx("rounded px-1.5 py-0.5 text-xs font-semibold uppercase ring-1", SEVERITY_STYLE[severity])}>
      {severity}
    </span>
  );
}

const STATUS_STYLE: Record<IncidentStatus, string> = {
  triggered: "bg-red-500 text-white",
  acknowledged: "bg-amber-400 text-zinc-950",
  investigating: "bg-violet-500 text-white",
  mitigated: "bg-sky-500 text-white",
  resolved: "bg-emerald-600 text-white",
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLE[status])}>
      {status === "triggered" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
      {status}
    </span>
  );
}

const SERVICE_STYLE: Record<ServiceStatus, { dot: string; label: string }> = {
  operational: { dot: "bg-emerald-500", label: "Operational" },
  degraded: { dot: "bg-amber-400", label: "Degraded" },
  outage: { dot: "bg-red-500 animate-pulse", label: "Outage" },
  maintenance: { dot: "bg-sky-400", label: "Maintenance" },
};

export function ServiceStatusPill({ status }: { status: ServiceStatus }) {
  const s = SERVICE_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
      <span className={cx("h-2 w-2 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-zinc-800 bg-zinc-900/60", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" | "success" };
export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  const styles = {
    primary: "bg-zinc-100 text-zinc-900 hover:bg-white",
    danger: "bg-red-600 text-white hover:bg-red-500",
    success: "bg-emerald-600 text-white hover:bg-emerald-500",
    ghost: "border border-zinc-700 text-zinc-200 hover:bg-zinc-800",
  }[variant];
  return (
    <button
      {...props}
      className={cx("rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", styles, className)}
    />
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{label}</p>;
}

// Shown whenever a request fails, so a page never sits on "Loading…".
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <span>{message}</span>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}
