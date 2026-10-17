import { z } from "zod";
import {
  addResponderSchema,
  alertPayloadSchema,
  applyAiDraftSchema,
  createApiKeySchema,
  createIncidentSchema,
  createServiceSchema,
  createWebhookSchema,
  deploymentPayloadSchema,
  escalationPolicySchema,
  logBatchSchema,
  loginSchema,
  noteSchema,
  rotateApiKeySchema,
  serviceDependenciesSchema,
  updateActionItemSchema,
  updatePostmortemSchema,
  updateResponderSchema,
  updateServiceSchema,
  updateSeveritySchema,
  updateStatusSchema,
  updateWebhookSchema,
} from "@irp/shared";
import { demoBodySchema } from "./routes/demo";
import { metricsQuerySchema } from "./routes/metrics";
import { serviceRulesSchema } from "./routes/services";

// OpenAPI 3.1 description of the HTTP API, served at GET /api/v1/openapi.json
// and committed as docs/openapi.json (`npm run openapi`).
//
// Request bodies are generated from the same zod schemas the routes parse, so
// they can't drift from what the API accepts. test/openapi.test.ts checks the
// other direction: every route registered in app.ts is in this table, and the
// committed file is current.

type Auth = "none" | "apiKey" | "session" | "admin";
type Operation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string; // Express syntax, relative to the server URL: /alerts/:id
  tag: string;
  summary: string;
  auth: Auth;
  body?: z.ZodType;
  query?: z.ZodObject;
  status?: number; // success status, default 200
  response?: string; // a named schema in components
};

const I = "/incidents/:number";
const PM = `${I}/postmortem`;

export const OPERATIONS: Operation[] = [
  // Machine endpoints (API keys)
  { method: "post", path: "/alerts", tag: "Ingestion", summary: "Ingest an alert (trigger or resolve); grouped by deduplication key", auth: "apiKey", body: alertPayloadSchema, status: 202, response: "AlertAccepted" },
  { method: "post", path: "/deployments", tag: "Ingestion", summary: "Report a deployment (CI/CD)", auth: "apiKey", body: deploymentPayloadSchema, status: 201 },
  { method: "post", path: "/logs", tag: "Ingestion", summary: "Send a batch of log events", auth: "apiKey", body: logBatchSchema, status: 202 },

  { method: "post", path: "/auth/login", tag: "Auth", summary: "Log in; sets the irp_session cookie and returns a token", auth: "none", body: loginSchema },
  { method: "post", path: "/auth/logout", tag: "Auth", summary: "Clear the session cookie", auth: "none", status: 204 },
  { method: "get", path: "/auth/me", tag: "Auth", summary: "The current user", auth: "session" },

  { method: "get", path: "/alerts", tag: "Alerts", summary: "Alert feed, newest first (filters: serviceId, severity, status)", auth: "session" },
  { method: "get", path: "/deployments", tag: "Telemetry", summary: "Recent deployments (filter: serviceId)", auth: "session" },

  { method: "get", path: "/incidents", tag: "Incidents", summary: "List incidents (filters: status, severity, serviceId)", auth: "session" },
  { method: "post", path: "/incidents", tag: "Incidents", summary: "Declare an incident manually", auth: "session", body: createIncidentSchema, status: 201 },
  { method: "get", path: I, tag: "Incidents", summary: "Incident with alerts, responders and pages", auth: "session" },
  { method: "get", path: `${I}/timeline`, tag: "Incidents", summary: "Append-only, hash-chained timeline with verification result", auth: "session" },
  { method: "post", path: `${I}/status`, tag: "Incidents", summary: "Move through the state machine (409 on an invalid transition)", auth: "session", body: updateStatusSchema },
  { method: "post", path: `${I}/acknowledge`, tag: "Incidents", summary: "Acknowledge; stops escalation and the ack timeout", auth: "session" },
  { method: "post", path: `${I}/escalate`, tag: "Incidents", summary: "Page the next escalation step now", auth: "session" },
  { method: "post", path: `${I}/severity`, tag: "Incidents", summary: "Change severity", auth: "session", body: updateSeveritySchema },
  { method: "post", path: `${I}/notes`, tag: "Incidents", summary: "Add a note to the timeline", auth: "session", body: noteSchema, status: 201 },
  { method: "post", path: `${I}/responders`, tag: "Responders", summary: "Add a responder (commander, responder or observer)", auth: "session", body: addResponderSchema, status: 201 },
  { method: "patch", path: `${I}/responders/:userId`, tag: "Responders", summary: "Change a responder's role (hand over command)", auth: "session", body: updateResponderSchema },
  { method: "delete", path: `${I}/responders/:userId`, tag: "Responders", summary: "Remove a responder", auth: "session", status: 204 },

  { method: "get", path: `${I}/investigations`, tag: "Investigations", summary: "The incident's investigations and their findings", auth: "session" },
  { method: "post", path: `${I}/investigations`, tag: "Investigations", summary: "Start an investigation (agent or offline rules)", auth: "session", status: 202 },
  { method: "post", path: `${I}/investigations/:id/hypotheses/:hid/post`, tag: "Investigations", summary: "Post a hypothesis to the timeline as an unconfirmed note", auth: "session", status: 201 },

  { method: "get", path: "/postmortems", tag: "Postmortems", summary: "All postmortems", auth: "session" },
  { method: "get", path: PM, tag: "Postmortems", summary: "The incident's postmortem", auth: "session" },
  { method: "get", path: `${PM}/markdown`, tag: "Postmortems", summary: "Postmortem as Markdown", auth: "session" },
  { method: "post", path: PM, tag: "Postmortems", summary: "Create the postmortem draft from the timeline", auth: "session", status: 201 },
  { method: "put", path: PM, tag: "Postmortems", summary: "Edit, publish or reopen", auth: "session", body: updatePostmortemSchema },
  { method: "patch", path: `${PM}/action-items/:itemId`, tag: "Postmortems", summary: "Update an action item", auth: "session", body: updateActionItemSchema },
  { method: "get", path: `${PM}/ai-drafts`, tag: "Postmortems", summary: "AI drafts for this postmortem", auth: "session" },
  { method: "post", path: `${PM}/ai-drafts`, tag: "Postmortems", summary: "Request an AI draft (worker job)", auth: "session", status: 202 },
  { method: "post", path: `${PM}/ai-drafts/:draftId/apply`, tag: "Postmortems", summary: "Apply selected sections of a draft (needs review)", auth: "session", body: applyAiDraftSchema },
  { method: "post", path: `${PM}/ai-drafts/:draftId/discard`, tag: "Postmortems", summary: "Discard a draft", auth: "session", status: 204 },

  { method: "get", path: "/metrics", tag: "Metrics", summary: "MTTA / MTTR per day, service and severity", auth: "session", query: metricsQuerySchema },
  { method: "get", path: "/demo", tag: "Demo", summary: "State of the incident simulation", auth: "session" },
  { method: "post", path: "/demo/simulate", tag: "Demo", summary: "Simulate a production incident", auth: "admin", body: demoBodySchema, status: 202 },

  { method: "get", path: "/services", tag: "Services", summary: "Services with status and open incidents", auth: "session" },
  { method: "post", path: "/services", tag: "Services", summary: "Create a service", auth: "admin", body: createServiceSchema, status: 201 },
  { method: "patch", path: "/services/:id", tag: "Services", summary: "Update a service (policy, maintenance window)", auth: "admin", body: updateServiceSchema },
  { method: "get", path: "/services/:id/keys", tag: "Services", summary: "The service's API keys (prefixes only)", auth: "admin" },
  { method: "post", path: "/services/:id/keys", tag: "Services", summary: "Create an API key (the secret is shown once)", auth: "admin", body: createApiKeySchema, status: 201 },
  { method: "post", path: "/services/:id/keys/:keyId/rotate", tag: "Services", summary: "Rotate a key with a grace period", auth: "admin", body: rotateApiKeySchema, status: 201 },
  { method: "post", path: "/services/:id/keys/:keyId/revoke", tag: "Services", summary: "Revoke a key", auth: "admin" },
  { method: "get", path: "/services/:id/rules", tag: "Services", summary: "Alert matching rules", auth: "session" },
  { method: "put", path: "/services/:id/rules", tag: "Services", summary: "Replace alert matching rules", auth: "admin", body: serviceRulesSchema },
  { method: "get", path: "/services/:id/dependencies", tag: "Services", summary: "Upstream dependencies (for the investigator)", auth: "session" },
  { method: "put", path: "/services/:id/dependencies", tag: "Services", summary: "Replace upstream dependencies", auth: "admin", body: serviceDependenciesSchema },

  { method: "get", path: "/escalation-policies", tag: "Escalation", summary: "Escalation policies", auth: "session" },
  { method: "get", path: "/escalation-policies/:id", tag: "Escalation", summary: "One policy with its steps", auth: "session" },
  { method: "post", path: "/escalation-policies", tag: "Escalation", summary: "Create a policy", auth: "admin", body: escalationPolicySchema, status: 201 },
  { method: "put", path: "/escalation-policies/:id", tag: "Escalation", summary: "Replace a policy", auth: "admin", body: escalationPolicySchema },
  { method: "delete", path: "/escalation-policies/:id", tag: "Escalation", summary: "Delete an unused policy", auth: "admin", status: 204 },

  { method: "get", path: "/webhooks", tag: "Webhooks", summary: "Webhook endpoints", auth: "admin" },
  { method: "post", path: "/webhooks", tag: "Webhooks", summary: "Create an endpoint (the signing secret is shown once)", auth: "admin", body: createWebhookSchema, status: 201 },
  { method: "patch", path: "/webhooks/:id", tag: "Webhooks", summary: "Update an endpoint", auth: "admin", body: updateWebhookSchema },
  { method: "delete", path: "/webhooks/:id", tag: "Webhooks", summary: "Delete an endpoint", auth: "admin", status: 204 },
  { method: "post", path: "/webhooks/:id/rotate-secret", tag: "Webhooks", summary: "Rotate the signing secret", auth: "admin" },
  { method: "post", path: "/webhooks/:id/test", tag: "Webhooks", summary: "Send a signed test event", auth: "admin", status: 202 },
  { method: "get", path: "/webhooks/:id/deliveries", tag: "Webhooks", summary: "Delivery log", auth: "admin" },
  { method: "post", path: "/webhooks/deliveries/:id/redeliver", tag: "Webhooks", summary: "Redeliver one delivery", auth: "admin", status: 202 },

  { method: "get", path: "/admin/queues", tag: "Operations", summary: "Job counts per queue and live workers", auth: "admin" },
  { method: "get", path: "/admin/ingestion", tag: "Operations", summary: "Alert ingestion throughput and latency percentiles (this API process)", auth: "admin", response: "IngestionStats" },
  { method: "get", path: "/admin/dead-letter", tag: "Operations", summary: "Jobs that used up their retries", auth: "admin" },
  { method: "post", path: "/admin/dead-letter/:id/retry", tag: "Operations", summary: "Put a dead letter back on its queue", auth: "admin" },
  { method: "delete", path: "/admin/dead-letter/:id", tag: "Operations", summary: "Discard a dead letter", auth: "admin", status: 204 },

  { method: "get", path: "/users", tag: "Organization", summary: "Users in the organization", auth: "session" },
  { method: "get", path: "/teams", tag: "Organization", summary: "Teams and members", auth: "session" },
  { method: "get", path: "/audit-log", tag: "Organization", summary: "Organization audit log (paged with ?before=)", auth: "admin" },
  { method: "get", path: "/stats", tag: "Organization", summary: "Dashboard counters", auth: "session" },
  { method: "get", path: "/stream", tag: "Realtime", summary: "Server-Sent Events stream; resumes from Last-Event-ID", auth: "session" },
  { method: "get", path: "/openapi.json", tag: "Meta", summary: "This document", auth: "none" },
];

const SECURITY: Record<Auth, Record<string, string[]>[] | undefined> = {
  none: [],
  apiKey: [{ apiKey: [] }],
  session: [{ sessionCookie: [] }, { sessionToken: [] }],
  admin: [{ sessionCookie: [] }, { sessionToken: [] }],
};

const ERROR_STATUSES: Record<Auth, number[]> = {
  none: [400],
  apiKey: [400, 401, 403, 413, 429, 503],
  session: [400, 401, 404, 409],
  admin: [400, 401, 403, 404, 409],
};

const ERROR_TEXT: Record<number, string> = {
  400: "Invalid request",
  401: "Not authenticated",
  403: "Not allowed",
  404: "Not found (also for other organizations' resources)",
  409: "Conflicts with the current state",
  413: "Body too large",
  429: "Rate limited; see Retry-After",
  503: "Postgres unavailable; retry after Retry-After",
};

function jsonSchema(schema: z.ZodType) {
  // "input": what a client sends (defaults optional, before transforms).
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, "{$1}");

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const parameters = [...op.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (op.query) {
      const props = (jsonSchema(op.query).properties ?? {}) as Record<string, unknown>;
      for (const [name, schema] of Object.entries(props)) parameters.push({ name, in: "query", required: false, schema: schema as never });
    }
    const success = op.status ?? 200;
    const responses: Record<string, unknown> = {
      [success]:
        success === 204
          ? { description: "No content" }
          : {
              description: "OK",
              content: { [op.path.endsWith("/markdown") ? "text/markdown" : op.path === "/stream" ? "text/event-stream" : "application/json"]: { schema: op.response ? { $ref: `#/components/schemas/${op.response}` } : {} } },
            },
    };
    for (const status of ERROR_STATUSES[op.auth]) {
      if (status === 401 && op.auth === "none") continue;
      responses[status] = { $ref: `#/components/responses/E${status}` };
    }
    (paths[toOpenApiPath(op.path)] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      operationId: operationId(op),
      security: SECURITY[op.auth],
      ...(op.auth === "admin" ? { description: "Requires the admin role." } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } } } : {}),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Fireline — Incident Response Platform API",
      version: "1.0.0",
      description:
        "Alert ingestion, incident lifecycle, escalation, investigations and postmortems. Machine endpoints (alerts, deployments, logs) authenticate with a per-service API key; everything else with the session cookie or a Bearer session token. Prose reference: docs/api.md.",
      license: { name: "MIT" },
    },
    servers: [{ url: "http://localhost:4000/api/v1", description: "Local (docker compose / npm run dev:api)" }],
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "Per-service integration key: Authorization: Bearer ir_live_…" },
        sessionCookie: { type: "apiKey", in: "cookie", name: "irp_session" },
        sessionToken: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "The token returned by POST /auth/login" },
      },
      responses: Object.fromEntries(
        Object.entries(ERROR_TEXT).map(([status, description]) => [`E${status}`, { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }])
      ),
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" }, details: { description: "Validation issues (400 only)" } },
        },
        AlertAccepted: {
          type: "object",
          required: ["id", "status", "receivedAt", "service", "deduplicationKey", "decision"],
          properties: {
            id: { type: "string", examples: ["alert_01M4V1JQA6G5TKEBVMPF8Z6DPZ"] },
            status: { enum: ["triggered", "suppressed", "resolved"] },
            receivedAt: { type: "string", format: "date-time" },
            service: { type: "string" },
            deduplicationKey: { type: "string" },
            decision: { enum: ["incident_created", "grouped", "recorded", "suppressed", "maintenance", "resolved"] },
            reason: { type: "string" },
            incident: {
              type: ["object", "null"],
              properties: { id: { type: "integer" }, number: { type: "integer" }, status: { type: "string" }, severity: { type: "string" }, alertCount: { type: "integer" } },
            },
          },
        },
        IngestionStats: {
          type: ["object", "null"],
          properties: {
            windowSeconds: { type: "integer" },
            coveredSeconds: { type: "integer" },
            count: { type: "integer" },
            perSecond: { type: "number" },
            errors: { type: "integer" },
            latencyMs: {
              type: ["object", "null"],
              properties: { p50: { type: "number" }, p95: { type: "number" }, p99: { type: "number" }, max: { type: "number" } },
            },
            decisions: { type: "object", additionalProperties: { type: "integer" } },
            sinceStart: { type: "object", properties: { count: { type: "integer" }, errors: { type: "integer" }, startedAt: { type: "string", format: "date-time" } } },
          },
        },
      },
    },
  };
}

function operationId(op: Operation) {
  const words = op.path
    .split("/")
    .filter(Boolean)
    .map((part) => (part.startsWith(":") ? `by-${part.slice(1)}` : part))
    .join("-")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return [op.method, ...words].map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
}
