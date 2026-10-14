"use client";

import { Button, Card, cx, inputClass } from "@/components/ui";
import type { IncidentDetail, User } from "@/lib/types";

const ROLE_LABEL: Record<string, string> = {
  commander: "Incident Commander",
  responder: "Responder",
};

type Props = {
  responders: IncidentDetail["responders"];
  users: User[] | null;
  me: User | null;
  open: boolean;
  busy: boolean;
  act: (path: string, body?: unknown) => Promise<boolean>;
};

export function RespondersCard({ responders, users, me, open, busy, act }: Props) {
  const ids = new Set(responders.map((r) => r.id));
  const joined = me ? ids.has(me.id) : false;

  return (
    <Card
      title="Responders"
      actions={
        open && me && !joined ? (
          <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => act("/responders", { userId: me.id })}>
            Join
          </Button>
        ) : undefined
      }
    >
      <ul className="space-y-1.5 text-sm">
        {responders.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3">
            <span className="text-zinc-100">
              {r.name}
              {r.id === me?.id && <span className="ml-1 text-xs text-zinc-500">(you)</span>}
            </span>
            <span className={cx("text-xs", r.role === "commander" ? "text-amber-300" : "text-zinc-400")}>
              {ROLE_LABEL[r.role] ?? r.role}
            </span>
          </li>
        ))}
        {responders.length === 0 && <li className="text-zinc-500">Nobody has joined yet.</li>}
      </ul>
      {open && users && (
        <select
          className={cx(inputClass, "mt-3")}
          value=""
          disabled={busy}
          onChange={(e) => act("/responders", { userId: Number(e.target.value), role: "responder" })}
          aria-label="Add responder"
        >
          <option value="">+ Add responder…</option>
          {users
            .filter((u) => !ids.has(u.id))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
      )}
    </Card>
  );
}
