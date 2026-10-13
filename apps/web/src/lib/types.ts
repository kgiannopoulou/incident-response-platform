import type { IncidentSeverity, IncidentStatus, ServiceStatus } from "@irp/shared";

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
  type: string;
  message: string;
  created_at: string;
  actor_name: string | null;
};

export type IncidentDetail = {
  incident: IncidentSummary & {
    service_status: ServiceStatus | null;
    escalation_policy_name: string | null;
    next_escalation_at: string | null;
    allowed_transitions: IncidentStatus[];
  };
  alerts: {
    id: number;
    summary: string;
    severity: string;
    source: string;
    component: string | null;
    status: string;
    details: Record<string, unknown>;
    received_at: string;
  }[];
  timeline: TimelineEvent[];
  responders: { id: number; name: string; email: string; role: string }[];
  notifications: {
    id: number;
    kind: string;
    status: string;
    escalation_level: number | null;
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
  id: number;
  summary: string;
  severity: string;
  source: string;
  status: string;
  received_at: string;
  service_name: string;
  matched_rule: string | null;
  incident_number: number | null;
};

export type Postmortem = {
  status: "draft" | "published";
  summary: string;
  impact: string;
  root_cause: string;
  resolution: string;
  action_items: { description: string; owner: string; done: boolean }[];
  metrics: {
    timeToAcknowledgeSeconds: number | null;
    timeToResolveSeconds: number | null;
    alertCount: number;
    escalations: number;
    notesCount: number;
    responderCount: number;
  };
  timeline_markdown: string;
  generated_at: string;
  updated_at: string;
  updated_by_name: string | null;
  number: number;
  title: string;
  severity: IncidentSeverity;
  service_name: string | null;
};
