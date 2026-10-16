import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constructWebhookEvent, verifyWebhookSignature, WebhookSignatureError } from "../src/index";

// The platform signs with node:crypto (packages/shared/src/crypto.ts); the
// SDK verifies with Web Crypto. Both must agree byte for byte.
const SECRET = "whsec_test_secret";
const body = JSON.stringify({ id: "evt_01", event: "incident.triggered", createdAt: "2026-10-16T08:00:00Z" });
const sign = (t: number, payload = body, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const now = 1_760_600_000;

describe("verifyWebhookSignature", () => {
  it("accepts a signature made by the platform", async () => {
    expect(await verifyWebhookSignature(SECRET, body, sign(now), { now })).toBe(true);
    expect(await verifyWebhookSignature(SECRET, body, sign(now - 299), { now })).toBe(true);
  });

  it("rejects a modified body, a wrong secret, and malformed or missing headers", async () => {
    expect(await verifyWebhookSignature(SECRET, body.replace("triggered", "resolved"), sign(now), { now })).toBe(false);
    expect(await verifyWebhookSignature("whsec_other", body, sign(now), { now })).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, "t=abc,v1=zz", { now })).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, `t=${now}`, { now })).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, undefined, { now })).toBe(false);
  });

  it("rejects replays outside the tolerance window, in either direction", async () => {
    expect(await verifyWebhookSignature(SECRET, body, sign(now - 301), { now })).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, sign(now + 301), { now })).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, sign(now - 3600), { now, toleranceSeconds: 7200 })).toBe(true);
  });

  it("constructWebhookEvent parses after verifying and explains failures", async () => {
    await expect(constructWebhookEvent(SECRET, body, sign(now), { now })).resolves.toMatchObject({ id: "evt_01", event: "incident.triggered" });
    await expect(constructWebhookEvent(SECRET, body, sign(now - 1000), { now })).rejects.toThrow(/possible replay/);
    await expect(constructWebhookEvent("x", body, sign(now), { now })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
