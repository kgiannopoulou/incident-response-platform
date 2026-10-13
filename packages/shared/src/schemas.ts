import { z } from "zod";
import {
  ALERT_SEVERITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  SERVICE_STATUSES,
} from "./domain";

// Body of POST /api/v1/alerts, sent by monitoring tools (or @irp/alert-sdk).
// Modelled on the PagerDuty Events API: `action: "trigger"` raises or
// re-raises an alert, `action: "resolve"` clears every firing alert with the
// same dedup key.
export const alertPayloadSchema = z.object({
  action: z.enum(["trigger", "resolve"]).default("trigger"),
  summary: z.string().trim().min(1).max(500),
  severity: z.enum(ALERT_SEVERITIES).default("error"),
  source: z.string().trim().min(1).max(200), // host / check name, e.g. "prometheus:checkout-5xx"
  component: z.string().trim().max(200).optional(),
  // Optional: alerts with the same key are grouped into one incident. When
  // omitted it is derived from service + source + summary (see dedup.ts).
  dedupKey: z.string().trim().min(1).max(255).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type AlertPayload = z.infer<typeof alertPayloadSchema>;
export type AlertPayloadInput = z.input<typeof alertPayloadSchema>;

export const ruleConditionSchema = z.object({
  field: z.enum(["severity", "source", "summary", "component"]),
  op: z.enum(["equals", "contains", "at_least"]),
  value: z.string().min(1),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  conditions: z.array(ruleConditionSchema).max(10),
  action: z.enum(["create_incident", "suppress"]),
  incidentSeverity: z.enum(INCIDENT_SEVERITIES).nullable().optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const createIncidentSchema = z.object({
  title: z.string().trim().min(3).max(200),
  severity: z.enum(INCIDENT_SEVERITIES),
  serviceId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(2000).optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: z.string().trim().max(2000).optional(),
});

export const updateSeveritySchema = z.object({
  severity: z.enum(INCIDENT_SEVERITIES),
});

export const noteSchema = z.object({
  message: z.string().trim().min(1).max(5000),
});

export const addResponderSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(["commander", "responder"]).default("responder"),
});

export const createServiceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).default(""),
  teamId: z.number().int().positive().nullable().optional(),
  escalationPolicyId: z.number().int().positive().nullable().optional(),
  autoResolve: z.boolean().default(false),
});

export const updateServiceSchema = z.object({
  description: z.string().trim().max(500).optional(),
  // Only maintenance can be set by hand; the other statuses are derived
  // from open incidents. Setting "operational" ends maintenance.
  maintenance: z.boolean().optional(),
  autoResolve: z.boolean().optional(),
  escalationPolicyId: z.number().int().positive().nullable().optional(),
});

export const actionItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  owner: z.string().trim().max(100).default(""),
  done: z.boolean().default(false),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const updatePostmortemSchema = z.object({
  summary: z.string().max(10000).optional(),
  impact: z.string().max(10000).optional(),
  rootCause: z.string().max(10000).optional(),
  resolution: z.string().max(10000).optional(),
  actionItems: z.array(actionItemSchema).max(50).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

export const serviceStatusSchema = z.enum(SERVICE_STATUSES);
