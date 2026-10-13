import { describe, expect, it, vi } from "vitest";
import { AlertApiError, AlertClient } from "../src/index";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 202 });
const fail = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: `status ${status}` }), { status, headers });

const alert = { title: "Checkout down", severity: "CRITICAL" as const, source: "probe" };

describe("AlertClient", () => {
  it("sends the alert with the API key as a bearer token", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: "alert_01", status: "triggered" }));
    const client = new AlertClient({ baseUrl: "http://irp/", apiKey: "ir_live_k1", fetchImpl });
    await expect(client.trigger({ ...alert, service: "checkout-api" })).resolves.toMatchObject({ id: "alert_01" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://irp/api/v1/alerts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ir_live_k1");
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: "trigger",
      service: "checkout-api",
      severity: "CRITICAL",
      title: "Checkout down",
    });
  });

  it("resolves by deduplication key", async () => {
    const fetchImpl = vi.fn(async () => ok({ status: "resolved" }));
    const client = new AlertClient({ baseUrl: "http://irp", apiKey: "k", fetchImpl });
    await client.resolve({ deduplicationKey: "checkout-errors" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ action: "resolve", deduplicationKey: "checkout-errors" });
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fail(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok({ decision: "grouped" }));
    const client = new AlertClient({ baseUrl: "http://irp", apiKey: "k", fetchImpl, baseDelayMs: 1 });
    await expect(client.trigger(alert)).resolves.toMatchObject({ decision: "grouped" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("waits for Retry-After when rate limited", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fail(429, { "Retry-After": "2" }))
        .mockResolvedValueOnce(ok({ decision: "recorded" }));
      const client = new AlertClient({ baseUrl: "http://irp", apiKey: "k", fetchImpl, baseDelayMs: 1 });
      const pending = client.trigger(alert);
      await vi.advanceTimersByTimeAsync(1500);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still waiting
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toMatchObject({ decision: "recorded" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry client errors such as a revoked key", async () => {
    const fetchImpl = vi.fn(async () => fail(401));
    const client = new AlertClient({ baseUrl: "http://irp", apiKey: "bad", fetchImpl, baseDelayMs: 1 });
    await expect(client.trigger(alert)).rejects.toBeInstanceOf(AlertApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fetchImpl = vi.fn(async () => fail(500));
    const client = new AlertClient({ baseUrl: "http://irp", apiKey: "k", fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    await expect(client.trigger(alert)).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
