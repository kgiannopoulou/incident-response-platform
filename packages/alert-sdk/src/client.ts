import { errorFingerprint } from "./fingerprint.js";
import type {
  AlertInput,
  AlertResult,
  CaptureOptions,
  DeploymentInput,
  DeploymentResult,
  LogEntry,
  LogsResult,
  ErrorMode,
  IncidentClientOptions,
  MonitorOptions,
  ResolveInput,
  Severity,
} from "./types.js";

export const SDK_VERSION = "0.4.0";

const SEVERITIES: readonly Severity[] = ["critical", "high", "warning", "info"];

// The API answered with an error (or never answered).
export class IncidentApiError extends Error {
  constructor(
    public readonly status: number, // 0 = network error / timeout
    message: string,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "IncidentApiError";
  }
}

// The call was invalid before anything was sent (missing key, bad severity…).
export class IncidentClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentClientError";
  }
}

// Environment variables when running on Node; nothing elsewhere (edge runtimes, browsers).
const env = (name: string) => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Web Crypto's randomUUID exists on Node 19+, Deno, Bun, edge runtimes and browsers.
const newIdempotencyKey = () => `sdk-${globalThis.crypto.randomUUID()}`;

// Sends alerts to the incident platform from any application:
//
//   import { IncidentClient } from "@incident-platform/sdk";
//
//   const incidents = new IncidentClient({ apiKey: process.env.INCIDENT_API_KEY! });
//   await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db-connection" });
//   await incidents.resolve("db-connection");
//
//   try { … } catch (err) { await incidents.captureException(err); throw err; }
//   await incidents.monitor("nightly-billing", () => runBilling());
//
// Network errors, timeouts and 5xx are retried with exponential backoff and
// 429s wait for Retry-After. Retrying is safe: every call sends one
// Idempotency-Key, reused on each of its retries, so if the first attempt was
// committed but its response was lost (a timeout, a dropped connection) the
// platform replays that response instead of recording the alert twice.
// With onError "throw" (the default) calls resolve to the result; with "log"
// or a handler they may resolve to null instead of rejecting.
export type Result<M extends ErrorMode, T> = M extends "throw" ? T : T | null;
export type ClientResult<M extends ErrorMode> = Result<M, AlertResult>;

export class IncidentClient<M extends ErrorMode = "throw"> {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly options: Required<Omit<IncidentClientOptions, "apiKey" | "baseUrl" | "defaultMetadata">> & {
    defaultMetadata: Record<string, unknown>;
  };

  constructor(options: IncidentClientOptions & { onError?: M } = {}) {
    const apiKey = options.apiKey ?? env("INCIDENT_API_KEY");
    if (!apiKey) throw new IncidentClientError("An API key is required: pass { apiKey } or set INCIDENT_API_KEY");
    this.apiKey = apiKey;
    const baseUrl = options.baseUrl ?? env("INCIDENT_API_URL") ?? "http://localhost:4000";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.options = {
      source: options.source ?? "sdk",
      defaultMetadata: options.defaultMetadata ?? {},
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 250,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
      onError: options.onError ?? "throw",
      fetch: options.fetch ?? globalThis.fetch,
    };
  }

  // Raise an alert. Resolves to the platform's decision (incident created,
  // grouped, recorded, suppressed…), or null when onError swallowed a failure.
  alert(input: AlertInput): Promise<ClientResult<M>> {
    const severity = String(input.severity ?? "").toLowerCase() as Severity;
    if (!SEVERITIES.includes(severity)) {
      return Promise.reject(new IncidentClientError(`severity must be one of ${SEVERITIES.join(", ")} (got "${input.severity}")`));
    }
    if (!input.title?.trim()) return Promise.reject(new IncidentClientError("title is required"));
    const { idempotencyKey, ...fields } = input;
    return this.send(
      {
        action: "trigger",
        ...fields,
        severity,
        title: clip(input.title.trim(), 300),
        source: input.source ?? this.options.source,
        metadata: { ...this.options.defaultMetadata, ...input.metadata },
      },
      idempotencyKey
    );
  }

  // Clear alerts — by deduplication key (a string), or by title — so the
  // incident can auto-resolve once nothing is firing.
  resolve(input: ResolveInput): Promise<ClientResult<M>> {
    const body = typeof input === "string" ? { deduplicationKey: input } : input;
    return this.send({ action: "resolve", ...body });
  }

  // Report a caught exception as an alert. Repeats of the same bug share a
  // fingerprint, so they group into one incident.
  captureException(error: unknown, options: CaptureOptions = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    return this.alert({
      severity: options.severity ?? "high",
      title: options.title ?? clip(`${err.name}: ${err.message}`, 200),
      description: err.stack?.split("\n").slice(0, 15).join("\n") ?? err.message,
      deduplicationKey: options.deduplicationKey ?? errorFingerprint(err),
      metadata: { errorName: err.name, ...options.metadata },
    });
  }

  // Run a job and alert if it fails (the error is re-thrown). With
  // resolveOnSuccess (default), a later successful run clears the alert.
  async monitor<T>(name: string, job: () => T | Promise<T>, options: MonitorOptions = {}): Promise<T> {
    const deduplicationKey = options.deduplicationKey ?? `monitor:${name}`;
    try {
      const result = await job();
      if (options.resolveOnSuccess ?? true) await this.resolve(deduplicationKey).catch(() => null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.captureException(err, {
        ...options,
        deduplicationKey,
        title: options.title ?? clip(`${name} failed: ${message}`, 200),
        metadata: { job: name, ...options.metadata },
      }).catch(() => null);
      throw err;
    }
  }

  // Report a deployment or other change (config push, migration, feature
  // flag, rollback) from CI/CD. The incident investigator correlates changes
  // with the alerts and errors that follow them.
  //
  //   await incidents.deployment({ version: "v2.14.0", commitSha: process.env.GIT_SHA, description: "Raise worker concurrency" });
  deployment(input: DeploymentInput): Promise<Result<M, DeploymentResult>> {
    if (!input.version?.trim()) return Promise.reject(new IncidentClientError("version is required"));
    const startedAt = input.startedAt instanceof Date ? input.startedAt.toISOString() : input.startedAt;
    const finishedAt = input.finishedAt instanceof Date ? input.finishedAt.toISOString() : input.finishedAt;
    return this.request<DeploymentResult>("/api/v1/deployments", { ...input, startedAt, finishedAt }, newIdempotencyKey(), "deployment");
  }

  // Ship application log lines (warnings and errors are what matter) so an
  // investigation can spot new error patterns. Batches of up to 500 entries
  // per request; larger arrays are split.
  async logs(entries: LogEntry[]): Promise<Result<M, LogsResult>> {
    if (!entries.length) return { accepted: 0, service: null } as LogsResult;
    let accepted = 0;
    let service: string | null = null;
    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500).map((e) => ({ ...e, timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp }));
      const result = await this.request<LogsResult>("/api/v1/logs", { entries: batch }, newIdempotencyKey(), "logs");
      if (!result) return null as Result<M, LogsResult>;
      accepted += result.accepted;
      service = result.service;
    }
    return { accepted, service };
  }

  private send(payload: Record<string, unknown>, idempotencyKey?: string): Promise<ClientResult<M>> {
    return this.request<AlertResult>("/api/v1/alerts", payload, idempotencyKey ?? newIdempotencyKey(), "alert");
  }

  private async request<T>(path: string, payload: Record<string, unknown>, idempotencyKey: string, what: string): Promise<Result<M, T>> {
    try {
      return (await this.sendWithRetries<T>(path, payload, idempotencyKey)) as Result<M, T>;
    } catch (err) {
      const mode = this.options.onError;
      if (mode === "throw" || err instanceof IncidentClientError) throw err;
      if (mode === "log") console.error(`[incident-platform] ${what} not delivered: ${(err as Error).message}`);
      else mode(err);
      return null as Result<M, T>;
    }
  }

  private async sendWithRetries<T>(path: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    const { maxRetries, baseDelayMs, maxRetryAfterMs, timeoutMs } = this.options;
    const body = JSON.stringify(payload);
    let lastError: IncidentApiError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastError?.retryAfterSeconds;
        await sleep(retryAfter ? Math.min(retryAfter * 1000, maxRetryAfterMs) : baseDelayMs * 2 ** (attempt - 1));
      }
      let res: Response;
      try {
        res = await this.options.fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": `incident-platform-sdk/${SDK_VERSION}`,
            // The same key on every retry of this call (see the class comment).
            "Idempotency-Key": idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = (err as Error)?.name === "TimeoutError";
        lastError = new IncidentApiError(0, timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
      const retryAfter = Number(res.headers.get("retry-after"));
      lastError = new IncidentApiError(res.status, errorBody.error ?? res.statusText, retryAfter > 0 ? retryAfter : null);
      // 4xx other than 429: the request itself is wrong (bad key, invalid payload) — don't retry.
      if (res.status < 500 && res.status !== 429) throw lastError;
    }
    throw lastError!;
  }
}
