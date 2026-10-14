import { describe, expect, it, vi } from "vitest";
import { compareStreamIds, isStreamId, parseRealtimeMessage, publishRealtime } from "../src/realtime";

describe("realtime helpers", () => {
  it("compares Redis stream ids numerically, not as strings", () => {
    expect(compareStreamIds("999-0", "1000-0")).toBe(-1);
    expect(compareStreamIds("1000-10", "1000-9")).toBe(1);
    expect(compareStreamIds("1000-1", "1000-1")).toBe(0);
  });

  it("recognises stream ids", () => {
    expect(isStreamId("1760429748123-0")).toBe(true);
    expect(isStreamId("abc")).toBe(false);
    expect(isStreamId(undefined)).toBe(false);
  });

  it("splits pub/sub messages into id and payload", () => {
    expect(parseRealtimeMessage('17-0 {"type":"timeline.added","incidentId":1}')).toEqual({
      id: "17-0",
      json: '{"type":"timeline.added","incidentId":1}',
    });
  });

  it("appends to the org stream and publishes on the org channel in one script", async () => {
    const redis = { eval: vi.fn(async () => "17-0") };
    const id = await publishRealtime(redis, 7, { type: "service.updated", serviceId: 3 });
    expect(id).toBe("17-0");
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("XADD"),
      2,
      "irp:stream:org:7",
      "irp:events:org:7",
      '{"type":"service.updated","serviceId":3}',
      1000
    );
  });
});
