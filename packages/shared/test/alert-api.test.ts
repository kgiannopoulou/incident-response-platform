import { describe, expect, it } from "vitest";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from "../src/crypto";
import { newAlertId, ulid, ULID_PATTERN, ulidTime } from "../src/ids";
import { alertPayloadSchema, slugify } from "../src/schemas";

const example = {
  service: "checkout-api",
  severity: "critical",
  title: "Checkout error rate exceeded threshold",
  description: "Error rate reached 38%",
  source: "prometheus",
  deduplicationKey: "checkout-errors",
  metadata: { errorRate: 38, region: "eu-west-1" },
};

describe("alertPayloadSchema", () => {
  it("accepts the documented example", () => {
    expect(alertPayloadSchema.parse(example)).toEqual({ ...example, action: "trigger" });
  });

  it("accepts severities in any case and normalises them", () => {
    for (const [input, stored] of [
      ["INFO", "info"],
      ["Warning", "warning"],
      ["HIGH", "high"],
      [" critical ", "critical"],
    ]) {
      expect(alertPayloadSchema.parse({ ...example, severity: input }).severity).toBe(stored);
    }
  });

  it("rejects unknown severities and missing required fields", () => {
    expect(alertPayloadSchema.safeParse({ ...example, severity: "error" }).success).toBe(false);
    const missing = alertPayloadSchema.safeParse({ source: "x" });
    expect(missing.success).toBe(false);
    expect(missing.error!.issues.map((i) => i.path[0]).sort()).toEqual(["severity", "title"]);
  });

  it("lets a resolve identify the alert by deduplication key alone", () => {
    expect(alertPayloadSchema.safeParse({ action: "resolve", deduplicationKey: "checkout-errors" }).success).toBe(true);
    expect(alertPayloadSchema.safeParse({ action: "resolve" }).success).toBe(false);
  });

  it("defaults description, source and metadata", () => {
    expect(alertPayloadSchema.parse({ severity: "high", title: "x" })).toMatchObject({
      description: "",
      source: "api",
      metadata: {},
    });
  });
});

describe("ULID alert ids", () => {
  it("look like alert_<26 Crockford base32 chars>", () => {
    const id = newAlertId();
    expect(id).toMatch(/^alert_/);
    expect(id.slice(6)).toMatch(ULID_PATTERN);
  });

  it("encode their creation time, so they sort chronologically", () => {
    const t = Date.UTC(2026, 9, 10, 6, 32, 18);
    expect(ulidTime(ulid(t))).toBe(t);
    const ids = [ulid(t + 2000), ulid(t), ulid(t + 1000)].sort();
    expect(ids.map(ulidTime)).toEqual([t, t + 1000, t + 2000]);
  });

  it("are unique", () => {
    expect(new Set(Array.from({ length: 1000 }, () => ulid())).size).toBe(1000);
  });
});

describe("API keys", () => {
  it("have the ir_live_ prefix and 192 random bits", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^ir_live_[0-9a-f]{48}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it("are stored as a SHA-256 hash and shown by a short prefix only", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toContain(key.slice(8));
    expect(apiKeyDisplayPrefix(key)).toBe(key.slice(0, 16));
  });
});

describe("slugify", () => {
  it("turns service names into API slugs", () => {
    expect(slugify("Checkout API")).toBe("checkout-api");
    expect(slugify("  PostgreSQL / Primary  ")).toBe("postgresql-primary");
  });
});
