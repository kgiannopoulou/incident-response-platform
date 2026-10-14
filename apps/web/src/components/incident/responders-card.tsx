"use client";

import { RESPONDER_ROLE_LABEL, RESPONDER_ROLES, type ResponderRole } from "@irp/shared";
import { Button, Card, cx, inputClass } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import type { IncidentDetail, User } from "@/lib/types";

// INC-142
//   Incident Commander  Konstantina
//   Responders          Maria, George
//   Observers           Alex
//
// Join as responder or observer, switch between them, leave; the commander
// (or an admin) hands over command and manages other people. The API
// enforces the same rules; the buttons only hide what would be refused.

const GROUP_TITLE: Record<ResponderRole, string> = {
  commander: "Incident Commander",
  responder: "Responders",
  observer: "Observers",
};

type Props = {
  number: number;
  responders: IncidentDetail["responders"];
  users: User[] | null;
  me: User | null;
  open: boolean;
  busy: boolean;
  act: (path: string, body?: unknown) => Promise<boolean>;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
};

export function RespondersCard({ number, responders, users, me, open, busy, act, run }: Props) {
  const mine = responders.find((r) => r.id === me?.id)?.role ?? null;
  const hasCommander = responders.some((r) => r.role === "commander");
  const lead = me?.role === "admin" || mine === "commander";
  const onIncident = new Set(responders.map((r) => r.id));

  const setRole = (userId: number, role: ResponderRole) =>
    run(() => apiFetch(`/incidents/${number}/responders/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }));
  const remove = (userId: number) => run(() => apiFetch(`/incidents/${number}/responders/${userId}`, { method: "DELETE" }));

  return (
    <Card title="Responders" actions={mine && <span className="text-xs text-zinc-500">You: {RESPONDER_ROLE_LABEL[mine]}</span>}>
      <div className="space-y-3">
        {RESPONDER_ROLES.map((role) => {
          const people = responders.filter((r) => r.role === role);
          return (
            <div key={role}>
              <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{GROUP_TITLE[role]}</h3>
              {people.length === 0 ? (
                <p className="text-sm text-zinc-600">{role === "commander" ? "Unassigned" : "—"}</p>
              ) : (
                <ul className="space-y-1">
                  {people.map((r) => {
                    const self = r.id === me?.id;
                    return (
                      <li key={r.id} className="group flex items-center justify-between gap-2 text-sm">
                        <span className={cx(role === "commander" ? "font-medium text-amber-200" : "text-zinc-100")}>
                          {r.name}
                          {self && <span className="ml-1 text-xs text-zinc-500">(you)</span>}
                        </span>
                        {open && lead && !self && role !== "commander" && (
                          <span className="flex gap-2 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100">
                            <button className="hover:text-amber-300" disabled={busy} onClick={() => setRole(r.id, "commander")}>
                              Make commander
                            </button>
                            <button className="hover:text-red-300" disabled={busy} onClick={() => remove(r.id)}>
                              Remove
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {open && me && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
          {mine === null && (
            <>
              <Button className="py-1 text-xs" disabled={busy} onClick={() => act("/responders", { role: "responder" })}>
                Join as responder
              </Button>
              <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => act("/responders", { role: "observer" })}>
                Observe
              </Button>
            </>
          )}
          {mine === "observer" && (
            <Button className="py-1 text-xs" disabled={busy} onClick={() => setRole(me.id, "responder")}>
              Join as responder
            </Button>
          )}
          {mine === "responder" && (
            <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => setRole(me.id, "observer")}>
              Switch to observer
            </Button>
          )}
          {mine !== "commander" && (!hasCommander || lead) && (
            <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => setRole(me.id, "commander")}>
              Take command
            </Button>
          )}
          {(mine === "responder" || mine === "observer") && (
            <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => remove(me.id)}>
              Leave
            </Button>
          )}
        </div>
      )}

      {open && users && lead && (
        <select
          className={cx(inputClass, "mt-3")}
          value=""
          disabled={busy}
          onChange={(e) => act("/responders", { userId: Number(e.target.value), role: "responder" })}
          aria-label="Add responder"
        >
          <option value="">+ Add someone as responder…</option>
          {users
            .filter((u) => !onIncident.has(u.id))
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
