import { createHash } from "node:crypto";

// Server-only (uses node:crypto), so it's a separate entry point —
// `@irp/shared/dedup` — and not re-exported from the browser-safe index.

// Alerts that describe "the same problem" must map to the same key so they
// group into one incident instead of paging once per check run. Numbers in
// the summary are masked so "p99 latency 2300ms" and "p99 latency 2410ms"
// count as the same alert.
export function normalizeSummary(summary: string) {
  return summary
    .toLowerCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeDedupKey(serviceId: number, source: string, summary: string) {
  const fingerprint = `${serviceId}|${source.trim().toLowerCase()}|${normalizeSummary(summary)}`;
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}

// Integration keys are random secrets shown once; only their hash is stored.
export function hashIntegrationKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}
