import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signWebhook, verifyWebhookSignature } from "../src/crypto";
import { buildWebhookPayload, createWebhookSchema, renderPageEmail } from "../src/webhooks";

const incident = {
  number: 142,
  title: "Checkout API unavailable",
  severity: "sev1" as const,
  status: "triggered" as const,
  serviceName: "Checkout API",
  serviceSlug: "checkout-api",
  escalationLevel: 1,
  triggeredAt: new Date("2026-10-14T14:02:00Z"),
  acknowledgedAt: null,
  resolvedAt: null,
};

describe("webhook payload", () => {
  it("matches the documented shape", () => {
    const payload = buildWebhookPayload("incident.triggered", "evt_1", incident, {
      webOrigin: "https://fireline.example/",
      now: new Date("2026-10-14T14:02:01Z"),
    });
    expect(payload).toEqual({
      id: "evt_1",
      event: "incident.triggered",
      createdAt: "2026-10-14T14:02:01.000Z",
      incident: {
        id: "INC-142",
        number: 142,
        title: "Checkout API unavailable",
        severity: "critical",
        severityLevel: "sev1",
        severityLabel: "SEV1 · Critical",
        status: "triggered",
        service: { name: "Checkout API", slug: "checkout-api" },
        escalationLevel: 1,
        url: "https://fireline.example/incidents/142",
        triggeredAt: "2026-10-14T14:02:00.000Z",
        acknowledgedAt: null,
        resolvedAt: null,
      },
      actor: null,
    });
  });

  it("a ping carries no incident", () => {
    expect(buildWebhookPayload("ping", "evt_2", null, { webOrigin: "x" })).not.toHaveProperty("incident");
  });

  it("only accepts http(s) endpoint URLs and defaults to every event", () => {
    expect(createWebhookSchema.safeParse({ url: "ftp://example.com" }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(createWebhookSchema.parse({ url: "https://hooks.example.com/x" }).events).toHaveLength(4);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ event: "incident.triggered" });

  it("round-trips and rejects tampering, wrong secrets and stale timestamps", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    const header = signWebhook(secret, body, 1_760_430_000);
    expect(header).toMatch(/^t=1760430000,v1=[0-9a-f]{64}$/);

    const now = 1_760_430_010;
    expect(verifyWebhookSignature(secret, body, header, { now })).toBe(true);
    expect(verifyWebhookSignature(secret, body + " ", header, { now })).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, header, { now })).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, { now: now + 3600 })).toBe(false); // replayed an hour later
    expect(verifyWebhookSignature(secret, body, "garbage", { now })).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, { now })).toBe(false);
  });
});

describe("page email", () => {
  it("puts severity, incident and service in the subject and links to the incident", () => {
    const email = renderPageEmail({
      kind: "escalated",
      recipientName: "Riley <Eng Manager>",
      incident: { number: 142, title: "Checkout API unavailable", severity: "sev1", serviceName: "Checkout API" },
      escalationLevel: 3,
      webOrigin: "https://fireline.example",
    });
    expect(email.subject).toBe("[SEV1 · Critical] ESCALATED — still unacknowledged: INC-142 Checkout API unavailable (Checkout API)");
    expect(email.text).toContain("You are on escalation level 3");
    expect(email.text).toContain("https://fireline.example/incidents/142");
    expect(email.html).toContain("Riley &lt;Eng Manager&gt;"); // escaped
  });
});
