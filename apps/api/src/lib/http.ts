import type { NextFunction, Request, Response } from "express";
import { isDatabaseUnavailable } from "@irp/database";
import { InvalidTransitionError } from "@irp/shared";
import { z, ZodError } from "zod";

// Thrown by handlers for expected failures; turned into { error } JSON by
// errorHandler below (Express 5 forwards rejected async handlers here).
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function parseId(value: string | string[] | undefined, what = "Resource") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw notFound(what);
  return id;
}

// An optional numeric filter from the query string (?serviceId=3). Anything
// that isn't a positive integer is a 400 — never passed on to SQL.
export function optionalIdQuery(value: unknown, name: string) {
  if (value === undefined || value === "") return null;
  const id = Number(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return id;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", details: z.flattenError(err) });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof InvalidTransitionError) {
    return res.status(409).json({ error: err.message, from: err.from, to: err.to, allowed: err.allowed });
  }
  // The database's own transition guard (migration 0004) — only reachable if
  // a code path skipped the state machine.
  if ((err as { code?: string })?.code === "23514") {
    return res.status(409).json({ error: (err as Error).message });
  }
  // A value Postgres couldn't parse for its column type (safety net behind
  // input validation): the client's fault, and no details are echoed.
  if ((err as { code?: string })?.code === "22P02") {
    return res.status(400).json({ error: "Invalid parameter" });
  }
  // Postgres unique violation that a handler didn't anticipate.
  if ((err as { code?: string })?.code === "23505") {
    return res.status(409).json({ error: "Conflicts with an existing record" });
  }
  // Postgres is unreachable (down, restarting, failing over). 503 +
  // Retry-After tells monitoring tools and the SDK to retry the same request
  // shortly; nothing was committed, so the retry is safe.
  if (isDatabaseUnavailable(err)) {
    console.error(`[degraded] database unavailable: ${(err as Error).message}`);
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "Database unavailable; retry shortly", retryable: true });
  }
  // Body over the 256 kB limit (was a 500 before Phase 24's tests).
  if ((err as { type?: string })?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  // Malformed JSON body.
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
