"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorState, inputClass } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { state, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("alex@acme.test");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status === "signed-in") router.replace("/");
  }, [state.status, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded bg-red-600 text-sm">⚡</span>
            Fireline
          </h1>
          <p className="mt-1 text-sm text-zinc-400">Incident response for on-call teams.</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-300">Email</span>
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-300">Password</span>
          <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <ErrorState message={error} />}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-xs text-zinc-500">
          Demo accounts (after <code>npm run db:seed</code>): alex@acme.test (admin), sam@acme.test, jordan@acme.test — password
          <code> password123</code>.
        </p>
      </form>
    </main>
  );
}
