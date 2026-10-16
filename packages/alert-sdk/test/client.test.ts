import { afterEach, describe, expect, it, vi } from "vitest";
import { errorFingerprint, IncidentApiError, IncidentClient, IncidentClientError, normalizeMessage, SDK_VERSION, type AlertResult } from "../src/index";

const ok = (body: unknown = { decision: "incident_created" }) => new Response(JSON.stringify(body), { status: 202 });
const fail = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: `status ${status}` }), { status, headers });

const sent = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => {
  const [url, init] = fetchImpl.mock.calls[call] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("IncidentClient.alert", () => {
  it("sends the plan's example: severity, title and deduplication key with the API key", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: "alert_01", decision: "incident_created" }));
    const incidents = new IncidentClient({ apiKey: "ir_live_k1", baseUrl: "http://irp/", fetch: fetchImpl });
    const result = await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db-connection" });
    expect(result).toMatchObject({ id: "alert_01", decision: "incident_created" });

    const { url, headers, body } = sent(fetchImpl);
    expect(url).toBe("http://irp/api/v1/alerts");
    expect(headers.Authorization).toBe("Bearer ir_live_k1");
    expect(headers["User-Agent"]).toBe(`incident-platform-sdk/${SDK_VERSION}`);
    expect(body).toEqual({
      action: "trigger",
      severity: "critical",
      title: "Database connection failure",
      deduplicationKey: "db-connection",
      source: "sdk",
      metadata: {},
    });
  });

  it("sends one Idempotency-Key per call and reuses it on every retry of that call", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? fail(503) : n === 2 ? fail(502) : ok()));
    const incidents = new IncidentClient({ apiKey: "ir_live_k1", fetch: fetchImpl, baseDelayMs: 1 });
    await incidents.alert({ severity: "high", title: "Queue backlog" });
    await incidents.alert({ severity: "high", title: "Queue backlog" });
    const keys = fetchImpl.mock.calls.map((_, i) => sent(fetchImpl, i).headers["Idempotency-Key"]);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^sdk-[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]); // a new call is a new alert
  });

  it("uses a caller-supplied idempotency key and keeps it out of the body", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new IncidentClient({ apiKey: "ir_live_k1", fetch: fetchImpl }).alert({
      severity: "critical",
      title: "Payment provider down",
      idempotencyKey: "alertmanager-7f3a",
    });
    expect(sent(fetchImpl).headers["Idempotency-Key"]).toBe("alertmanager-7f3a");
    expect(sent(fetchImpl).body).not.toHaveProperty("idempotencyKey");
  });

  it("reads the key and URL from INCIDENT_API_KEY / INCIDENT_API_URL", async () => {
    vi.stubEnv("INCIDENT_API_KEY", "ir_live_from_env");
    vi.stubEnv("INCIDENT_API_URL", "https://incidents.example.com");
    const fetchImpl = vi.fn(async () => ok());
    await new IncidentClient({ fetch: fetchImpl }).alert({ severity: "info", title: "Deploy finished" });
    expect(sent(fetchImpl).url).toBe("https://incidents.example.com/api/v1/alerts");
    expect(sent(fetchImpl).headers.Authorization).toBe("Bearer ir_live_from_env");
  });

  it("refuses to start without a key, and rejects invalid alerts before sending anything", async () => {
    vi.stubEnv("INCIDENT_API_KEY", "");
    expect(() => new IncidentClient()).toThrow(IncidentClientError);
    const fetchImpl = vi.fn();
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl });
    await expect(incidents.alert({ severity: "urgent" as "high", title: "x" })).rejects.toThrow(/severity must be one of/);
    await expect(incidents.alert({ severity: "high", title: "  " })).rejects.toThrow(/title is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts upper-case severities and merges default metadata and source", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl, source: "checkout-service", defaultMetadata: { region: "eu-west-1", version: "1.4.2" } });
    await incidents.alert({ severity: "HIGH", title: "Slow", metadata: { p99: 1800, version: "1.4.3" } });
    expect(sent(fetchImpl).body).toMatchObject({ severity: "high", source: "checkout-service", metadata: { region: "eu-west-1", version: "1.4.3", p99: 1800 } });
  });
});

describe("retries", () => {
  it("retries 5xx, network errors and timeouts, then succeeds", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fail(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(ok({ decision: "grouped" }));
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl, baseDelayMs: 1 });
    await expect(incidents.alert({ severity: "critical", title: "Down" })).resolves.toMatchObject({ decision: "grouped" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // The same body every time: retrying is safe because the platform dedups by key.
    expect(new Set(fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).body)).size).toBe(1);
  });

  it("aborts a hanging request after timeoutMs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
    );
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl as unknown as typeof fetch, timeoutMs: 20, maxRetries: 1, baseDelayMs: 1 });
    await expect(incidents.alert({ severity: "high", title: "x" })).rejects.toMatchObject({ status: 0, message: "Timed out after 20 ms" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("waits for Retry-After when rate limited", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(fail(429, { "Retry-After": "2" })).mockResolvedValueOnce(ok({ decision: "recorded" }));
    const pending = new IncidentClient({ apiKey: "k", fetch: fetchImpl, baseDelayMs: 1 }).alert({ severity: "info", title: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toMatchObject({ decision: "recorded" });
  });

  it("does not retry client errors such as a revoked key", async () => {
    const fetchImpl = vi.fn(async () => fail(401));
    const incidents = new IncidentClient({ apiKey: "bad", fetch: fetchImpl, baseDelayMs: 1 });
    await expect(incidents.alert({ severity: "high", title: "x" })).rejects.toBeInstanceOf(IncidentApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries with the last error", async () => {
    const fetchImpl = vi.fn(async () => fail(500));
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    await expect(incidents.alert({ severity: "high", title: "x" })).rejects.toMatchObject({ status: 500, name: "IncidentApiError" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("onError", () => {
  it('"log" never lets a delivery failure crash the app', async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const incidents = new IncidentClient({ apiKey: "k", fetch: vi.fn(async () => fail(500)), baseDelayMs: 1, maxRetries: 0, onError: "log" });
    const result: AlertResult | null = await incidents.alert({ severity: "high", title: "x" });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("alert not delivered: status 500"));
    log.mockRestore();
  });

  it("hands the error to a custom handler, but still rejects invalid input", async () => {
    const handler = vi.fn();
    const incidents = new IncidentClient({ apiKey: "k", fetch: vi.fn(async () => fail(503)), baseDelayMs: 1, maxRetries: 0, onError: handler });
    await expect(incidents.alert({ severity: "high", title: "x" })).resolves.toBeNull();
    expect(handler.mock.calls[0][0]).toMatchObject({ status: 503 });
    await expect(incidents.alert({ severity: "high", title: "" })).rejects.toBeInstanceOf(IncidentClientError);
  });
});

describe("resolve, captureException and monitor", () => {
  it("resolves by deduplication key or title", async () => {
    const fetchImpl = vi.fn(async () => ok({ decision: "resolved" }));
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl });
    await incidents.resolve("db-connection");
    await incidents.resolve({ title: "CPU > 80%", source: "node-exporter" });
    expect(sent(fetchImpl, 0).body).toEqual({ action: "resolve", deduplicationKey: "db-connection" });
    expect(sent(fetchImpl, 1).body).toEqual({ action: "resolve", title: "CPU > 80%", source: "node-exporter" });
  });

  it("turns an exception into an alert with its stack and a stable fingerprint", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl });
    const boom = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id') for order 4711");
    };
    for (let i = 0; i < 2; i++) {
      try {
        boom();
      } catch (err) {
        await incidents.captureException(err, { metadata: { orderId: 4711 + i } });
      }
    }
    const [first, second] = [sent(fetchImpl, 0).body, sent(fetchImpl, 1).body];
    expect(first).toMatchObject({
      severity: "high",
      title: "TypeError: Cannot read properties of undefined (reading 'id') for order 4711",
      deduplicationKey: expect.stringMatching(/^exc-[0-9a-f]{8}$/),
      metadata: { errorName: "TypeError", orderId: 4711 },
    });
    expect(first.description).toContain("at boom");
    expect(second.deduplicationKey).toBe(first.deduplicationKey); // same bug → one incident
  });

  it("monitors a job: alerts and re-throws on failure, clears the alert on success", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const incidents = new IncidentClient({ apiKey: "k", fetch: fetchImpl });
    await expect(incidents.monitor("nightly-billing", () => Promise.reject(new Error("card processor unreachable")))).rejects.toThrow("card processor unreachable");
    expect(sent(fetchImpl, 0).body).toMatchObject({
      action: "trigger",
      title: "nightly-billing failed: card processor unreachable",
      deduplicationKey: "monitor:nightly-billing",
      metadata: { job: "nightly-billing" },
    });
    await expect(incidents.monitor("nightly-billing", () => 42)).resolves.toBe(42);
    expect(sent(fetchImpl, 1).body).toEqual({ action: "resolve", deduplicationKey: "monitor:nightly-billing" });
  });
});

describe("errorFingerprint", () => {
  const thrownAt = (make: () => Error) => {
    try {
      throw make();
    } catch (err) {
      return err as Error;
    }
  };

  it("masks ids, numbers and quoted values in messages", () => {
    expect(normalizeMessage(`Order 4711 failed for "alice" after 2.5s (id 3f2a8c1e-0b7d-4c55-9a43-2d9e1f6b7c80)`)).toBe(
      "order <n> failed for <str> after <n>s (id <uuid>)"
    );
  });

  it("groups the same error from the same place, separates different errors", () => {
    const a = errorFingerprint(thrownAt(() => new Error("timeout after 3000ms")));
    const b = errorFingerprint(thrownAt(() => new Error("timeout after 5000ms")));
    const c = errorFingerprint(thrownAt(() => new RangeError("timeout after 3000ms")));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ignores line numbers, so a redeploy doesn't open new incidents", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at handler (/srv/app/checkout.js:41:17)";
    const moved = new Error("boom");
    moved.stack = "Error: boom\n    at handler (/srv/app/checkout.js:58:3)";
    expect(errorFingerprint(err)).toBe(errorFingerprint(moved));
  });
});
