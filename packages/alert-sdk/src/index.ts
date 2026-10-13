import type { AlertPayloadInput } from "@irp/shared";

// What a monitoring tool or application embeds to raise alerts:
//
//   const irp = new AlertClient({ baseUrl: "http://localhost:4000", integrationKey: "..." });
//   await irp.trigger({ summary: "Checkout 5xx > 5%", severity: "critical", source: "prometheus" });
//   await irp.resolve({ summary: "Checkout 5xx > 5%", source: "prometheus" });
//
// Network errors, 429s and 5xx responses are retried with exponential
// backoff — the endpoint is idempotent per dedup key, so a retried alert
// groups into the same incident instead of opening a second one.

export type AlertResult = {
  alertId: number | null;
  dedupKey: string;
  decision: "incident_created" | "grouped" | "recorded" | "suppressed" | "resolved" | "maintenance";
  incident: { id: number; number: number; status: string } | null;
};

export type AlertClientOptions = {
  baseUrl: string;
  integrationKey: string;
  maxRetries?: number;
  baseDelayMs?: number;
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
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AlertClientOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  trigger(alert: Omit<AlertPayloadInput, "action">) {
    return this.send({ ...alert, action: "trigger" });
  }

  resolve(alert: Pick<AlertPayloadInput, "summary" | "source" | "dedupKey">) {
    return this.send({ ...alert, action: "resolve" });
  }

  async send(payload: AlertPayloadInput): Promise<AlertResult> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/api/v1/alerts`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.baseDelayMs * 2 ** (attempt - 1));
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.integrationKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return (await res.json()) as AlertResult;

        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const error = new AlertApiError(res.status, body.error ?? res.statusText);
        // 4xx (except 429) means the request itself is wrong — don't retry.
        if (res.status < 500 && res.status !== 429) throw error;
        lastError = error;
      } catch (err) {
        if (err instanceof AlertApiError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}
