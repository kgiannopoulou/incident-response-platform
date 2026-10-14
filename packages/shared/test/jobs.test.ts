import { describe, expect, it } from "vitest";
import { backoffDelay, deliverJobOptions, escalateJobOptions, RETRY_POLICY } from "../src/jobs";

describe("job retry policy", () => {
  it("backs off exponentially: 2 s, 4 s, 8 s, 16 s between page attempts", () => {
    const waits = Array.from({ length: RETRY_POLICY.notifications.attempts - 1 }, (_, i) => backoffDelay("notifications", i + 1));
    expect(waits).toEqual([2000, 4000, 8000, 16000]);
  });

  it("dedups deliveries by notification id and keeps no finished jobs", () => {
    expect(deliverJobOptions(42)).toMatchObject({
      jobId: "notification-42",
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it("retries escalation steps too, and carries the delay for the next step", () => {
    expect(escalateJobOptions(300_000)).toMatchObject({ delay: 300_000, attempts: 5, backoff: { type: "exponential" } });
  });
});
