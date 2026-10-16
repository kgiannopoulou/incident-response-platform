import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS, TEST_PASSWORD } from "@irp/database/testing";
import { checkJwtSecret } from "../src/lib/security";
import { createTestContext, type TestContext } from "./helpers";

// Phase 24: the security controls in docs/threat-model.md, each exercised
// through the real app.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const WEB = "http://localhost:3000";
const login = (email = "sam@test.dev", password = TEST_PASSWORD, origin?: string) => {
  const req = request(t.app).post("/api/v1/auth/login");
  if (origin) req.set("Origin", origin);
  return req.send({ email, password });
};
async function sessionCookie() {
  const res = await login();
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("irp_session="));
  if (!cookie) throw new Error("no session cookie");
  return { raw: cookie, header: cookie.split(";")[0] };
}

describe("security headers", () => {
  it("API responses forbid sniffing, framing and loading anything", async () => {
    const res = await request(t.app).get("/health/live");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("authenticated API responses are never cached", async () => {
    const res = await request(t.app).get("/api/v1/incidents").set(await t.as("sam"));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("CORS only lets the web app read responses with credentials", async () => {
    const ok = await request(t.app).options("/api/v1/incidents").set("Origin", WEB).set("Access-Control-Request-Method", "POST");
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await request(t.app).options("/api/v1/incidents").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    // The allowed origin is fixed, so a browser on another origin sees a mismatch and blocks the read.
    expect(evil.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
  });
});

describe("session cookie", () => {
  it("is httpOnly and SameSite=Strict", async () => {
    const { raw } = await sessionCookie();
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\//);
  });
});

describe("CSRF protection (cookie-authenticated writes must come from the web app)", () => {
  it("refuses a cookie-authenticated POST from another origin, or with no origin at all", async () => {
    await t.alert(TEST_KEYS.checkout, { severity: "critical", title: "Checkout down" }).expect(202);
    const { header } = await sessionCookie();
    const evil = await request(t.app).post("/api/v1/incidents/1/acknowledge").set("Cookie", header).set("Origin", "https://evil.example");
    expect(evil.status).toBe(403);
    expect(evil.body.error).toMatch(/Cross-site request refused/);
    await request(t.app).post("/api/v1/incidents/1/acknowledge").set("Cookie", header).expect(403);
    await request(t.app)
      .post("/api/v1/incidents/1/acknowledge")
      .set("Cookie", header)
      .set("Referer", "https://evil.example/page")
      .expect(403);
    const { rows } = await t.deps.pool.query(`SELECT status FROM incidents`);
    expect(rows[0].status).toBe("triggered");
  });

  it("allows the same request from the web app's origin (Origin or Referer)", async () => {
    await t.alert(TEST_KEYS.checkout, { severity: "critical", title: "Checkout down" }).expect(202);
    const { header } = await sessionCookie();
    await request(t.app).post("/api/v1/incidents/1/acknowledge").set("Cookie", header).set("Origin", WEB).expect(200);
    await request(t.app).post("/api/v1/incidents/1/notes").set("Cookie", header).set("Referer", `${WEB}/incidents/1`).send({ message: "on it" }).expect(201);
  });

  it("doesn't affect reads, Bearer-token clients or API-key ingestion", async () => {
    const { header } = await sessionCookie();
    await request(t.app).get("/api/v1/incidents").set("Cookie", header).expect(200);
    await t.alert(TEST_KEYS.checkout, { severity: "critical", title: "Checkout down" }).set("Origin", "https://evil.example").expect(202);
    await request(t.app).post("/api/v1/incidents/1/acknowledge").set(await t.as("sam")).set("Origin", "https://evil.example").expect(200);
  });

  it("refuses login CSRF (a foreign page signing the victim in)", async () => {
    await login("sam@test.dev", TEST_PASSWORD, "https://evil.example").expect(403);
    await login("sam@test.dev", TEST_PASSWORD, WEB).expect(200);
  });

  it("never parses a form or text/plain body (what a cross-site <form> can send)", async () => {
    const res = await request(t.app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ email: "sam@test.dev", password: TEST_PASSWORD }));
    expect(res.status).toBe(400);
  });
});

describe("password guessing", () => {
  it("locks an account after 10 failures, even for the right password, and audits the attempts", async () => {
    for (let i = 0; i < 10; i++) await login("sam@test.dev", `wrong-${i}`).expect(401);
    const locked = await login("sam@test.dev", TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
    // Other accounts are unaffected.
    await login("jordan@test.dev", TEST_PASSWORD).expect(200);

    const { rows } = await t.deps.pool.query(`SELECT action, count(*)::int AS n FROM audit_log WHERE action LIKE 'auth.%' GROUP BY action ORDER BY action`);
    expect(rows).toEqual([
      { action: "auth.login", n: 1 },
      { action: "auth.login_failed", n: 10 },
    ]);
  });

  it("gives unknown emails and wrong passwords the same answer", async () => {
    const unknown = await login("nobody@test.dev", "x");
    const wrong = await login("sam@test.dev", "x");
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("a successful login clears the account's failure count", async () => {
    for (let i = 0; i < 9; i++) await login("sam@test.dev", "wrong").expect(401);
    await login().expect(200);
    for (let i = 0; i < 9; i++) await login("sam@test.dev", "wrong").expect(401);
    await login().expect(200);
  });
});

describe("session tokens", () => {
  const claims = { id: 1, organizationId: 1, role: "admin", name: "Mallory", email: "m@evil.example" };
  const get = (token: string) => request(t.app).get("/api/v1/incidents").set("Authorization", `Bearer ${token}`);

  it("rejects unsigned (alg: none), foreign-secret, wrong-algorithm, wrong-audience and expired tokens", async () => {
    const none = jwt.sign(claims, "", { algorithm: "none" as never });
    await get(none).expect(401);
    await get(jwt.sign(claims, "not-the-secret", { issuer: "fireline-api", audience: "fireline-web" })).expect(401);
    await get(jwt.sign(claims, "test-secret", { algorithm: "HS512", issuer: "fireline-api", audience: "fireline-web" })).expect(401);
    await get(jwt.sign(claims, "test-secret", { issuer: "fireline-api", audience: "something-else" })).expect(401);
    await get(jwt.sign(claims, "test-secret", { issuer: "fireline-api", audience: "fireline-web", expiresIn: -10 })).expect(401);
    // The genuine article works.
    await get(jwt.sign(claims, "test-secret", { issuer: "fireline-api", audience: "fireline-web" })).expect(200);
  });

  it("refuses to run a real installation with a weak or example JWT secret", () => {
    expect(checkJwtSecret("short", { demo: false })).toMatchObject({ ok: false, error: expect.stringMatching(/only 5 characters/) });
    expect(checkJwtSecret("change-me-to-a-long-random-string", { demo: false })).toMatchObject({ ok: false });
    expect(checkJwtSecret("change-me-to-a-long-random-string", { demo: true })).toMatchObject({ ok: true, warning: expect.any(String) });
    expect(checkJwtSecret("Q2xhdWRlIHdhcyBoZXJlIGJ1dCBvbmx5IGFzIGEgdGVzdCBzZWNyZXQ", { demo: false })).toEqual({ ok: true });
  });
});

describe("SQL injection", () => {
  const payloads = ["'; DROP TABLE incidents; --", "' OR '1'='1", "1; SELECT pg_sleep(5)", "$1", "\\'; --"];

  it("stores hostile alert text literally (parameterized queries everywhere)", async () => {
    for (const p of payloads) {
      await t.alert(TEST_KEYS.checkout, { severity: "warning", title: p, description: p, source: p, deduplicationKey: p, metadata: { p } }).expect(202);
    }
    const { rows } = await t.deps.pool.query(`SELECT title FROM alerts ORDER BY id`);
    expect(rows.map((r) => r.title)).toEqual(payloads);
    const { rows: tables } = await t.deps.pool.query(`SELECT to_regclass('incidents') IS NOT NULL AS exists`);
    expect(tables[0].exists).toBe(true);
  });

  it("answers hostile query parameters with 400/404 or an empty result, never data or a 500", async () => {
    await t.alert(TEST_KEYS.checkout, { severity: "critical", title: "Checkout down" }).expect(202);
    const headers = await t.as("sam");
    await request(t.app).get("/api/v1/alerts?serviceId=1%20OR%201%3D1").set(headers).expect(400);
    await request(t.app).get("/api/v1/incidents?serviceId=1;DROP%20TABLE%20x").set(headers).expect(400);
    await request(t.app).get("/api/v1/incidents/1%20OR%201%3D1").set(headers).expect(404);
    const status = await request(t.app).get("/api/v1/incidents?status=%27%20OR%20%271%27%3D%271").set(headers);
    expect(status.status).toBe(200);
    expect(status.body.incidents).toEqual([]);
    const severity = await request(t.app).get("/api/v1/alerts?severity=%27%20OR%201%3D1--").set(headers);
    expect(severity.status).toBe(200); // unknown values are ignored as filters, and still parameterized
  });
});

describe("input validation", () => {
  it("rejects oversized bodies and unknown severities", async () => {
    await t.alert(TEST_KEYS.checkout, { severity: "critical", title: "x", metadata: { blob: "a".repeat(300_000) } }).expect(413);
    await t.alert(TEST_KEYS.checkout, { severity: "apocalyptic", title: "x" }).expect(400);
  });
});
