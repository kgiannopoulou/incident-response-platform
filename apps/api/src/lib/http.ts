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
  // Malformed JSON body.
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
