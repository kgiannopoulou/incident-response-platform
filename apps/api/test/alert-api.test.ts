import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { ulidTime } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);

// The documented example request.
const example = {
  service: "checkout-api",
  severity: "critical",
  title: "Checkout error rate exceeded threshold",
  description: "Error rate reached 38%",
  source: "prometheus",
  deduplicationKey: "checkout-errors",
  metadata: { errorRate: 38, region: "eu-west-1" },
};

describe("Phase 3: POST /api/v1/alerts contract", () => {
  it("returns an alert id, status and receivedAt", async () => {
    const before = Date.now();
    const res = await t.alert(TEST_KEYS.checkout, example);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "triggered",
      service: "checkout-api",
      deduplicationKey: "checkout-errors",
      decision: "incident_created",
    });
    expect(res.body.id).toMatch(/^alert_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.body.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // The id embeds its creation time.
    expect(Math.abs(ulidTime(res.body.id.slice(6)) - before)).toBeLessThan(5000);
  });

  it("stores title, description, metadata and the sending key", async () => {
    const res = await t.alert(TEST_KEYS.checkout, example);
    const { rows } = await t.deps.pool.query(
      `SELECT title, description, severity, source, metadata, status, api_key_id FROM alerts WHERE public_id = $1`,
      [res.body.id]
    );
    expect(rows[0]).toEqual({
      title: example.title,
      description: example.description,
      severity: "critical",
      source: "prometheus",
      metadata: example.metadata,
      status: "triggered",
      api_key_id: t.fx.apiKeys.checkout,
    });
  });

  it("supports INFO, WARNING, HIGH and CRITICAL in any case", async () => {
    const decisions: Record<string, string> = {};
    for (const severity of ["INFO", "WARNING", "HIGH", "CRITICAL"]) {
      const res = await t.alert(TEST_KEYS.auth, { ...example, service: undefined, severity, deduplicationKey: severity });
      expect(res.status).toBe(202);
      decisions[severity] = res.body.decision;
    }
    // Default rule: HIGH and CRITICAL page, INFO and WARNING are recorded.
    expect(decisions).toEqual({ INFO: "recorded", WARNING: "recorded", HIGH: "incident_created", CRITICAL: "incident_created" });

    const { rows } = await t.deps.pool.query(`SELECT severity FROM incidents ORDER BY id`);
    expect(rows.map((r) => r.severity)).toEqual(["sev2", "sev1"]);
  });

  it("rejects unknown severities with a helpful message", async () => {
    const res = await t.alert(TEST_KEYS.checkout, { ...example, severity: "SEVERE" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain("severity");
  });

  it("refuses to post as a different service than the key belongs to", async () => {
    const res = await t.alert(TEST_KEYS.checkout, { ...example, service: "auth-service" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/belongs to service "checkout-api"/);
  });

  it("resolves by deduplication key", async () => {
    await t.alert(TEST_KEYS.checkout, example);
    const res = await t.alert(TEST_KEYS.checkout, { action: "resolve", deduplicationKey: "checkout-errors" });
    expect(res.body).toMatchObject({ id: null, status: "resolved", resolvedCount: 1, incident: { status: "resolved" } });
  });

  it("feeds the dashboard newest first, filterable by severity", async () => {
    await t.alert(TEST_KEYS.checkout, { ...example, severity: "warning", title: "CPU > 80%", deduplicationKey: "cpu" });
    await t.alert(TEST_KEYS.checkout, example);
    const alex = await t.as("alex");
    const all = await api().get("/api/v1/alerts").set(alex);
    expect(all.body.alerts.map((a: { title: string }) => a.title)).toEqual([example.title, "CPU > 80%"]);
    expect(all.body.alerts[0]).toMatchObject({ severity: "critical", service_slug: "checkout-api", incident_number: 1 });

    const warnings = await api().get("/api/v1/alerts?severity=warning").set(alex);
    expect(warnings.body.alerts).toHaveLength(1);
  });
});

describe("Phase 4: API key authentication", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await api().post("/api/v1/alerts").send(example)).body.error).toMatch(/Missing API key/);
    const res = await t.alert("ir_live_not_a_real_key", example);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid API key");
  });

  it("stores only a hash: the plaintext key appears nowhere in the database", async () => {
    const alex = await t.as("alex");
    const created = await api().post(`/api/v1/services/${t.fx.services.checkout}/keys`).set(alex).send({ name: "Datadog" });
    expect(created.status).toBe(201);
    const key: string = created.body.apiKey.key;
    expect(key).toMatch(/^ir_live_[0-9a-f]{48}$/);
    expect(created.body.apiKey).toMatchObject({ name: "Datadog", prefix: key.slice(0, 16), state: "active" });

    const { rows } = await t.deps.pool.query(`SELECT row_to_json(k)::text AS row FROM api_keys k`);
    for (const { row } of rows) expect(row).not.toContain(key.slice(16));

    // Listing never returns the secret.
    const list = await api().get(`/api/v1/services/${t.fx.services.checkout}/keys`).set(alex);
    expect(JSON.stringify(list.body)).not.toContain(key.slice(16));
    expect(list.body.keys).toHaveLength(2);
  });

  it("rotates with a grace period: both keys work until the old one expires", async () => {
    const alex = await t.as("alex");
    const keyId = t.fx.apiKeys.checkout;
    const rotated = await api()
      .post(`/api/v1/services/${t.fx.services.checkout}/keys/${keyId}/rotate`)
      .set(alex)
      .send({ graceMinutes: 30 });
    expect(rotated.status).toBe(201);
    const newKey = rotated.body.apiKey.key;
    expect(new Date(rotated.body.previousKeyExpiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

    expect((await t.alert(TEST_KEYS.checkout, example)).status).toBe(202); // old: still in grace
    expect((await t.alert(newKey, example)).status).toBe(202); // new

    // Grace period over.
    await t.deps.pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1`, [keyId]);
    const expired = await t.alert(TEST_KEYS.checkout, example);
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatch(/expired/);
    expect((await t.alert(newKey, example)).status).toBe(202);

    const list = await api().get(`/api/v1/services/${t.fx.services.checkout}/keys`).set(alex);
    const old = list.body.keys.find((k: { id: number }) => k.id === keyId);
    expect(old).toMatchObject({ state: "expired", replaced_by_id: rotated.body.apiKey.id });
  });

  it("rotates immediately with graceMinutes: 0, and won't rotate a key twice", async () => {
    const alex = await t.as("alex");
    const url = `/api/v1/services/${t.fx.services.checkout}/keys/${t.fx.apiKeys.checkout}/rotate`;
    await api().post(url).set(alex).send({ graceMinutes: 0 }).expect(201);
    expect((await t.alert(TEST_KEYS.checkout, example)).status).toBe(401);
    expect((await api().post(url).set(alex).send({})).status).toBe(409);
  });

  it("revokes immediately and permanently", async () => {
    const alex = await t.as("alex");
    const url = `/api/v1/services/${t.fx.services.checkout}/keys/${t.fx.apiKeys.checkout}/revoke`;
    expect((await t.alert(TEST_KEYS.checkout, example)).status).toBe(202);
    const revoked = await api().post(url).set(alex);
    expect(revoked.body.apiKey).toMatchObject({ state: "revoked", prefix: "ir_live_test_che" });

    const res = await t.alert(TEST_KEYS.checkout, example);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("API key has been revoked");
    expect((await api().post(url).set(alex)).status).toBe(409);

    const audit = await api().get("/api/v1/audit-log").set(alex);
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toContain("api_key.revoke");
  });

  it("records when a key was last used, at most once a minute", async () => {
    const lastUsed = async () =>
      (await t.deps.pool.query(`SELECT last_used_at FROM api_keys WHERE id = $1`, [t.fx.apiKeys.checkout])).rows[0]
        .last_used_at as Date | null;
    expect(await lastUsed()).toBeNull();

    await t.alert(TEST_KEYS.checkout, example);
    const first = await lastUsed();
    expect(first).not.toBeNull();

    // Within the minute: not rewritten.
    await t.alert(TEST_KEYS.checkout, example);
    expect((await lastUsed())!.getTime()).toBe(first!.getTime());

    // Older than a minute: refreshed.
    await t.deps.pool.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [
      t.fx.apiKeys.checkout,
    ]);
    await t.alert(TEST_KEYS.checkout, example);
    expect(Date.now() - (await lastUsed())!.getTime()).toBeLessThan(10_000);
  });

  it("only lets admins of the same organization manage keys", async () => {
    const url = `/api/v1/services/${t.fx.services.checkout}/keys`;
    expect((await api().get(url).set(await t.as("sam"))).status).toBe(403);
    expect((await api().get(url).set(await t.as("eve"))).status).toBe(404);
    expect(
      (await api().post(`${url}/${t.fx.apiKeys.checkout}/revoke`).set(await t.as("eve"))).status
    ).toBe(404);
    // A key id from another service can't be addressed through this one.
    expect(
      (await api().post(`/api/v1/services/${t.fx.services.auth}/keys/${t.fx.apiKeys.checkout}/revoke`).set(await t.as("alex")))
        .status
    ).toBe(404);
  });
});

describe("Phase 4: rate limiting", () => {
  it("limits each key with a token bucket and reports it in headers", async () => {
    const alex = await t.as("alex");
    const created = await api()
      .post(`/api/v1/services/${t.fx.services.auth}/keys`)
      .set(alex)
      .send({ name: "Tiny", rateLimitPerMinute: 3 });
    const key = created.body.apiKey.key;

    const statuses: number[] = [];
    let last!: request.Response;
    for (let i = 0; i < 4; i++) {
      last = await t.alert(key, { ...example, service: undefined, deduplicationKey: `n${i}` });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(last.headers["ratelimit-limit"]).toBe("3");
    expect(last.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(last.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(last.body.error).toMatch(/3 alerts per minute/);

    // Other keys have their own buckets.
    expect((await t.alert(TEST_KEYS.auth, { ...example, service: undefined })).status).toBe(202);
  });

  it("blocks an IP after repeated failed authentications, even with a valid key", async () => {
    for (let i = 0; i < 20; i++) expect((await t.alert(`ir_live_guess_${i}`, example)).status).toBe(401);
    const blocked = await t.alert(TEST_KEYS.checkout, example);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
  });
});
