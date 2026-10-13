import { createHash } from "node:crypto";

// Server-only (uses node:crypto), so it's a separate entry point —
// `@irp/shared/dedup` — and not re-exported from the browser-safe index.

// Alerts that describe "the same problem" must map to the same key so they
// group into one incident instead of paging once per check run. Numbers in
// the title are masked so "p99 latency 2300ms" and "p99 latency 2410ms"
// count as the same alert.
export function normalizeTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

// Used when the sender doesn't provide a deduplicationKey.
export function computeDedupKey(serviceId: number, source: string, title: string) {
  const fingerprint = `${serviceId}|${source.trim().toLowerCase()}|${normalizeTitle(title)}`;
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}
