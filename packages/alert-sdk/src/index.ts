// @incident-platform/sdk — send alerts to the incident platform from your
// application. See README.md.
export { IncidentApiError, IncidentClient, IncidentClientError, SDK_VERSION, type ClientResult } from "./client.js";
export { errorFingerprint, normalizeMessage } from "./fingerprint.js";
export type {
  AlertInput,
  AlertResult,
  CaptureOptions,
  Decision,
  ErrorMode,
  IncidentClientOptions,
  MonitorOptions,
  ResolveInput,
  Severity,
  SeverityInput,
} from "./types.js";
