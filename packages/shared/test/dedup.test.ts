import { describe, expect, it } from "vitest";
import { computeDedupKey, normalizeTitle } from "../src/dedup";

describe("dedup keys", () => {
  it("masks numbers and whitespace so recurring alerts group together", () => {
    expect(normalizeTitle("p99  latency 2300ms on node 4")).toBe("p# latency #ms on node #");
    expect(computeDedupKey(1, "prom", "p99 latency 2300ms")).toBe(
      computeDedupKey(1, " PROM ", "P99 latency 2410ms")
    );
  });

  it("differs per service and per source", () => {
    const base = computeDedupKey(1, "prom", "disk full");
    expect(computeDedupKey(2, "prom", "disk full")).not.toBe(base);
    expect(computeDedupKey(1, "datadog", "disk full")).not.toBe(base);
  });
});
