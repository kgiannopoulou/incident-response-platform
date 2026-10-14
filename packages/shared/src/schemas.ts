import { z } from "zod";
import {
  ALERT_SEVERITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  RESPONDER_ROLES,
  SERVICE_STATUSES,
} from "./domain";

// Body of POST /api/v1/alerts, sent by monitoring tools (or @irp/alert-sdk):
//
//   { "service": "checkout-api", "severity": "critical",
//     "title": "Checkout error rate exceeded threshold",
//     "description": "Error rate reached 38%", "source": "prometheus",
//     "deduplicationKey": "checkout-errors", "metadata": { "errorRate": 38 } }
//
// `action` defaults to "trigger"; `action: "resolve"` clears every triggered
// alert with the same deduplication key (PagerDuty Events API style).
// Severity is case-insensitive: "CRITICAL" and "critical" are the same.
const alertSeverity = z.string().trim().toLowerCase().pipe(z.enum(ALERT_SEVERITIES));

export const alertPayloadSchema = z
  .object({
    action: z.enum(["trigger", "resolve"]).default("trigger"),
    // Service slug. The API key already identifies the service; when this is
    // sent it must match, so a key can't be used to post as another service.
    service: z.string().trim().min(1).max(100).optional(),
    severity: alertSeverity.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(5000).default(""),
    source: z.string().trim().min(1).max(200).default("api"),
    // Alerts with the same key are grouped into one incident. When omitted it
    // is derived from service + source + title (see dedup.ts).
    deduplicationKey: z.string().trim().min(1).max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((alert, ctx) => {
    if (alert.action === "trigger") {
      if (!alert.title) ctx.addIssue({ code: "custom", path: ["title"], message: "title is required" });
      if (!alert.severity) {
        ctx.addIssue({ code: "custom", path: ["severity"], message: "severity is required (INFO, WARNING, HIGH or CRITICAL)" });
      }
    } else if (!alert.deduplicationKey && !alert.title) {
      ctx.addIssue({
        code: "custom",
        path: ["deduplicationKey"],
        message: "resolve needs a deduplicationKey (or the title + source of the alert)",
      });
    }
  });
export type AlertPayload = z.infer<typeof alertPayloadSchema>;
export type AlertPayloadInput = z.input<typeof alertPayloadSchema>;

export const ruleConditionSchema = z.object({
  field: z.enum(["severity", "source", "title", "description"]),
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

// Omit userId to join yourself.
export const addResponderSchema = z.object({
  userId: z.number().int().positive().optional(),
  role: z.enum(RESPONDER_ROLES).default("responder"),
});

export const updateResponderSchema = z.object({
  role: z.enum(RESPONDER_ROLES),
});

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower-case letters, digits and single dashes, e.g. checkout-api")
  .max(100);

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export const createServiceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  // Defaults to slugify(name): "Checkout API" -> "checkout-api".
  slug: slugSchema.optional(),
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

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100).default("Default"),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(120),
});

export const rotateApiKeySchema = z.object({
  // How long the old key keeps working after rotation, so senders can switch
  // over without dropping alerts. 0 = invalidate immediately. Max 7 days.
  graceMinutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
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
