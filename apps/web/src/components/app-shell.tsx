"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { LiveProvider, useLiveConnected } from "@/lib/live";
import { cx, ErrorState, Loading } from "./ui";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/incidents", label: "Incidents" },
  { href: "/alerts", label: "Alerts" },
  { href: "/services", label: "Services" },
  { href: "/escalation-policies", label: "Escalation" },
  { href: "/audit", label: "Audit log", adminOnly: true },
];

function LiveIndicator() {
  const connected = useLiveConnected();
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-400" title={connected ? "Receiving live updates" : "Reconnecting…"}>
      <span className={cx("h-2 w-2 rounded-full", connected ? "bg-emerald-500" : "bg-zinc-600")} />
      {connected ? "Live" : "Offline"}
    </span>
  );
}

// Wraps every signed-in page: auth guard, navigation, live-update stream.
export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout, retry } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (state.status === "signed-out" && pathname !== "/login") router.replace("/login");
  }, [state.status, pathname, router]);

  if (pathname === "/login") return <>{children}</>;
  if (state.status === "error") {
    return (
      <main className="mx-auto max-w-lg p-8">
        <ErrorState message={state.message} onRetry={retry} />
      </main>
    );
  }
  if (state.status !== "signed-in") return <Loading />;
  const { user } = state;

  return (
    <LiveProvider enabled>
      <div className="min-h-screen">
        <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-zinc-100">
              <span className="grid h-6 w-6 place-items-center rounded bg-red-600 text-xs">⚡</span>
              Fireline
            </Link>
            <nav className="flex flex-wrap gap-1">
              {NAV.filter((item) => !item.adminOnly || user.role === "admin").map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cx("rounded-md px-3 py-1.5 text-sm", active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-100")}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-4 text-sm">
              <LiveIndicator />
              <span className="text-zinc-400">
                {user.name} · {user.organizationName} <span className="text-zinc-600">({user.role})</span>
              </span>
              <button onClick={logout} className="text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline">
                Sign out
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </div>
    </LiveProvider>
  );
}
