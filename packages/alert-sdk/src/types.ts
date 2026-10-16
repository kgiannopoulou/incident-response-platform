// Public types of @incident-platform/sdk. Self-contained on purpose: the
// published package has no runtime dependencies.

export type Severity = "critical" | "high" | "warning" | "info";
export type SeverityInput = Severity | Uppercase<Severity>;

export type AlertInput = {
  severity: SeverityInput;
  title: string;
  description?: string;
  // Repeats with the same key join the open incident instead of opening a new one.
  deduplicationKey?: string;
  // Service slug. Optional: the API key already identifies the service.
  service?: string;
  // Which tool or code path raised it ("prometheus", "checkout-worker"). Defaults to the client's `source`.
  source?: string;
  metadata?: Record<string, unknown>;
  // Sent as the Idempotency-Key header. Default: a fresh random key per
  // call, reused on its retries. Pass your own (e.g. the id of the event
  // that triggered the alert) to make repeats across processes safe too.
  idempotencyKey?: string;
};

export type ResolveInput =
  | string // a deduplication key
  | { deduplicationKey: string; service?: string }
  | { title: string; source?: string; service?: string };

export type Decision = "incident_created" | "grouped" | "recorded" | "suppressed" | "resolved" | "maintenance";

export type AlertResult = {
  id: string | null; // "alert_01J..." (null for a resolve)
  status: "triggered" | "resolved" | "suppressed";
  receivedAt: string;
  service: string;
  deduplicationKey: string;
  decision: Decision;
  reason: string;
  incident: { id: number; number: number; status: string; severity: string; alertCount: number } | null;
  resolvedCount?: number;
  // True when the platform replayed the stored response of an earlier
  // request with the same idempotency key (nothing new was recorded).
  replayed?: boolean;
};

export type CaptureOptions = {
  severity?: SeverityInput; // default "high"
  title?: string; // default "<ErrorName>: <message>"
  deduplicationKey?: string; // default: a fingerprint of the error type, message and throw site
  metadata?: Record<string, unknown>;
};

export type MonitorOptions = CaptureOptions & {
  // Clear the alert once the job succeeds again (default true), so the
  // incident auto-resolves on services that allow it.
  resolveOnSuccess?: boolean;
};

export type ErrorMode = "throw" | "log" | ((error: unknown) => void);

export type IncidentClientOptions = {
  // "ir_live_…". Default: process.env.INCIDENT_API_KEY.
  apiKey?: string;
  // Default: process.env.INCIDENT_API_URL, else http://localhost:4000.
  baseUrl?: string;
  // Default `source` for alerts that don't set one. Default "sdk".
  source?: string;
  // Merged into every alert's metadata (e.g. { region, version }).
  defaultMetadata?: Record<string, unknown>;
  // Per attempt. Default 10 s.
  timeoutMs?: number;
  // Retries after the first attempt for network errors, timeouts, 5xx and 429. Default 3.
  maxRetries?: number;
  // Exponential backoff base: 250 ms, 500 ms, 1 s, … Default 250.
  baseDelayMs?: number;
  // Cap on how long a 429's Retry-After may make a call wait. Default 30 s.
  maxRetryAfterMs?: number;
  // What a failed call does once retries are exhausted:
  //   "throw" (default) — reject with IncidentApiError
  //   "log"             — console.error and resolve to null, so alerting can never crash the app
  //   (err) => void     — your handler, then resolve to null
  onError?: ErrorMode;
  fetch?: typeof fetch;
};
