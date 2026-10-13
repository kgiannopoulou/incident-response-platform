import { describe, expect, it, vi } from "vitest";
import { AlertApiError, AlertClient } from "../src/index";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ error: `status ${status}` }), { status });

describe("AlertClient", () => {
  it("sends the alert with the integration key", async () => {
    const fetchImpl = vi.fn(async () => ok({ decision: "incident_created" }));
    const client = new AlertClient({ baseUrl: "http://irp/", integrationKey: "k1", fetchImpl });
    await client.trigger({ summary: "down", source: "probe" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://irp/api/v1/alerts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    expect(JSON.parse(init.body as string)).toMatchObject({ action: "trigger", summary: "down" });
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fail(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok({ decision: "grouped" }));
    const client = new AlertClient({ baseUrl: "http://irp", integrationKey: "k", fetchImpl, baseDelayMs: 1 });
    await expect(client.trigger({ summary: "x", source: "y" })).resolves.toMatchObject({ decision: "grouped" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi.fn(async () => fail(401));
    const client = new AlertClient({ baseUrl: "http://irp", integrationKey: "bad", fetchImpl, baseDelayMs: 1 });
    await expect(client.trigger({ summary: "x", source: "y" })).rejects.toBeInstanceOf(AlertApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fetchImpl = vi.fn(async () => fail(500));
    const client = new AlertClient({ baseUrl: "http://irp", integrationKey: "k", fetchImpl, baseDelayMs: 1, maxRetries: 2 });
    await expect(client.trigger({ summary: "x", source: "y" })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
