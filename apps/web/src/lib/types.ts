import type {
  ActionItem,
  AiDraftWarning,
  AiPostmortemOutput,
  AiSection,
  AlertSeverity,
  AlertStatus,
  EvidenceItem,
  IncidentSeverity,
  InvestigationFindings,
  IncidentStatus,
  PostmortemMetrics,
  PostmortemTimelineEntry,
  ResponderRole,
  ServiceStatus,
} from "@irp/shared";

export type User = {
  id: number;
  name: string;
  email: string;
  role: "admin" | "responder";
  organizationId: number;
  organizationName: string | null;
};

export type IncidentSummary = {
  id: number;
  number: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  alert_count: number;
  last_alert_at: string | null;
  escalation_level: number;
  triggered_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  service_id: number | null;
  service_name: string | null;
  commander_name: string | null;
};

export type TimelineEvent = {
  id: number;
  event_type: string;
  actor_id: number | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
};

// Result of re-verifying the timeline's hash chain (see migration 0005).
export type TimelineIntegrity = { valid: boolean; events: number; first_invalid_id: number | null };

export type IncidentDetail = {
  incident: IncidentSummary & {
    service_status: ServiceStatus | null;
    escalation_policy_name: string | null;
    escalation_max_level: number | null;
    next_escalation_at: string | null;
    ack_deadline_at: string | null;
    ack_timed_out_at: string | null;
    mitigated_at: string | null;
    allowed_transitions: IncidentStatus[];
  };
  alerts: {
    id: string;
    title: string;
    description: string;
    severity: AlertSeverity;
    source: string;
    status: AlertStatus;
    metadata: Record<string, unknown>;
    received_at: string;
  }[];
  timeline: TimelineEvent[];
  timeline_integrity: TimelineIntegrity;
  responders: { id: number; name: string; email: string; role: ResponderRole; joined_at: string }[];
  notifications: {
    id: number;
    kind: string;
    status: string;
    escalation_level: number | null;
    channel: "email";
    attempts: number;
    user_name: string;
    created_at: string;
    sent_at: string | null;
  }[];
  postmortem: { status: string; updated_at: string } | null;
};

export type Service = {
  id: number;
  name: string;
  slug: string;
  active_keys: number;
  description: string;
  status: ServiceStatus;
  auto_resolve: boolean;
  team_name: string | null;
  escalation_policy_id: number | null;
  escalation_policy_name: string | null;
  open_incidents: number;
  last_alert_at: string | null;
};

export type AlertRow = {
  id: string; // "alert_01J..."
  title: string;
  description: string;
  severity: AlertSeverity;
  source: string;
  status: AlertStatus;
  dedup_key: string;
  metadata: Record<string, unknown>;
  received_at: string;
  resolved_at: string | null;
  service_id: number;
  service_name: string;
  service_slug: string;
  matched_rule: string | null;
  api_key_prefix: string | null;
  incident_number: number | null;
};

export type ApiKey = {
  id: number;
  name: string;
  prefix: string;
  rate_limit_per_minute: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  replaced_by_id: number | null;
  created_by_name: string | null;
  revoked_by_name: string | null;
  state: "active" | "expiring" | "expired" | "revoked";
};

// Returned once, when a key is created or rotated.
export type NewApiKey = ApiKey & { key: string };

export type Postmortem = {
  status: "draft" | "published";
  summary: string;
  impact: string;
  root_cause: string;
  resolution: string;
  what_went_well: string;
  what_went_poorly: string;
  action_items: ActionItem[];
  metrics: Partial<PostmortemMetrics>;
  timeline: PostmortemTimelineEntry[];
  generated_at: string;
  updated_at: string;
  updated_by_name: string | null;
  published_at: string | null;
  published_by_name: string | null;
  number: number;
  title: string;
  severity: IncidentSeverity;
  service_name: string | null;
  triggered_at: string;
  resolved_at: string | null;
  ai_assisted_sections: AiSection[];
  ai_review_pending: boolean;
  ai_reviewed_by_name: string | null;
  ai_reviewed_at: string | null;
};

// A suggestion from the AI drafter (or the offline rules), awaiting review.
export type AiDraft = {
  id: number;
  status: "queued" | "generating" | "ready" | "failed" | "applied" | "discarded";
  provider: "claude" | "rules" | null;
  model: string | null;
  output: AiPostmortemOutput | null;
  warnings: AiDraftWarning[];
  usage: { inputTokens?: number; outputTokens?: number } | null;
  error: string | null;
  attempts: number;
  applied_sections: AiSection[];
  input_digest: string | null;
  input_events: number | null;
  created_at: string;
  completed_at: string | null;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
};

export type PostmortemSummary = {
  number: number;
  title: string;
  severity: IncidentSeverity;
  service_name: string | null;
  status: "draft" | "published";
  updated_at: string;
  published_at: string | null;
  duration_seconds: number | null;
  action_items_total: number;
  action_items_done: number;
};

export type EscalationPolicy = {
  id: number;
  name: string;
  description: string;
  ackTimeoutMinutes: number | null;
  steps: {
    position: number;
    delayMinutes: number;
    targets: { targetType: "user" | "team"; targetId: number; name: string }[];
  }[];
  services: { id: number; name: string }[];
  updated_at: string;
};

// GET /metrics?days= — dashboard metrics for a 7/30/90-day window.
export type MetricAggregates = {
  incidents: number;
  sev1: number;
  still_open: number;
  ack_timeouts: number;
  mtta_seconds: number | null;
  mttr_seconds: number | null;
  tta_p50_seconds: number | null;
  ttr_p50_seconds: number | null;
  ttr_p90_seconds: number | null;
};

export type DailyIncidents = { date: string; sev1: number; sev2: number; sev3: number; sev4: number };

export type Metrics = {
  window: { days: 7 | 30 | 90 };
  summary: MetricAggregates;
  previous: MetricAggregates;
  bySeverity: (MetricAggregates & { severity: IncidentSeverity })[];
  byService: (MetricAggregates & { id: number; name: string; slug: string; status: ServiceStatus; open_incidents: number })[];
  daily: DailyIncidents[];
  active: {
    id: number;
    number: number;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    triggered_at: string;
    acknowledged_at: string | null;
    alert_count: number;
    service_name: string | null;
  }[];
};

// An AI Incident Investigator run (or the offline correlation rules).
export type Investigation = {
  id: number;
  status: "queued" | "running" | "completed" | "failed";
  provider: "claude" | "rules" | null;
  model: string | null;
  findings: InvestigationFindings | null;
  evidence: Record<string, EvidenceItem>;
  steps: { tool: string; input: Record<string, unknown>; results: number; ms: number; error?: string }[];
  warnings: string[];
  usage: Record<string, number> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  requested_by_name: string | null;
};
