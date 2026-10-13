import type { AlertPayloadInput } from "@irp/shared";

// What a monitoring tool or application embeds to raise alerts:
//
//   const irp = new AlertClient({ baseUrl: "http://localhost:4000", apiKey: process.env.IRP_API_KEY! });
//   await irp.trigger({
//     service: "checkout-api",
//     severity: "CRITICAL",
//     title: "Checkout error rate exceeded threshold",
//     description: "Error rate reached 38%",
//     source: "prometheus",
//     deduplicationKey: "checkout-errors",
//     metadata: { errorRate: 38, region: "eu-west-1" },
//   });
//   await irp.resolve({ deduplicationKey: "checkout-errors" });
//
// Network errors and 5xx responses are retried with exponential backoff;
// 429s wait for the server's Retry-After. The endpoint is idempotent per
// deduplication key, so a retried alert groups into the same incident
// instead of opening a second one.

export type AlertResult = {
  id: string | null; // "alert_01J..." (null for a resolve)
  status: "triggered" | "resolved" | "suppressed";
  receivedAt: string;
  service: string;
  deduplicationKey: string;
  decision: "incident_created" | "grouped" | "recorded" | "suppressed" | "resolved" | "maintenance";
  reason: string;
  incident: { id: number; number: number; status: string } | null;
  resolvedCount?: number;
};

export type TriggerInput = Omit<AlertPayloadInput, "action" | "title" | "severity"> & {
  title: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL" | "info" | "warning" | "high" | "critical";
};

export type ResolveInput =
  | { deduplicationKey: string; service?: string }
  | { title: string; source?: string; service?: string };

export type AlertClientOptions = {
  baseUrl: string;
  apiKey: string; // "ir_live_..."
  maxRetries?: number;
  baseDelayMs?: number;
  maxRetryAfterMs?: number; // cap on how long a 429 Retry-After may make us wait
  fetchImpl?: typeof fetch;
};

export class AlertApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AlertClient {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AlertClientOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  trigger(alert: TriggerInput) {
    return this.send({ ...alert, action: "trigger" });
  }

  resolve(alert: ResolveInput) {
    return this.send({ ...alert, action: "resolve" });
  }

  async send(payload: AlertPayloadInput): Promise<AlertResult> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/api/v1/alerts`;
    let lastError: unknown;
    let waitMs = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(waitMs || this.baseDelayMs * 2 ** (attempt - 1));
      waitMs = 0;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return (await res.json()) as AlertResult;

        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const error = new AlertApiError(res.status, body.error ?? res.statusText);
        // 4xx (except 429) means the request itself is wrong: don't retry.
        if (res.status < 500 && res.status !== 429) throw error;
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          if (retryAfter > 0) waitMs = Math.min(retryAfter * 1000, this.maxRetryAfterMs);
        }
        lastError = error;
      } catch (err) {
        if (err instanceof AlertApiError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}
