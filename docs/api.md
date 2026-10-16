# API reference

Base URL: `http://localhost:4000/api/v1`. JSON in and out. Errors are `{ "error": "message" }`
(validation errors add `details`).

Authentication:

- **API key** (alert ingestion only): `Authorization: Bearer ir_live_…`. Each key belongs to one service.
- **Session** (everything else): the `irp_session` httpOnly cookie set by `POST /auth/login`, or
  `Authorization: Bearer <token>` using the `token` returned by login.

## Alerts

### `POST /alerts` — ingest an alert *(API key)*

```json
{
  "service": "checkout-api",
  "severity": "critical",
  "title": "Checkout error rate exceeded threshold",
  "description": "Error rate reached 38%",
  "source": "prometheus",
  "deduplicationKey": "checkout-errors",
  "metadata": { "errorRate": 38, "region": "eu-west-1" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `severity` | yes (trigger) | `INFO`, `WARNING`, `HIGH` or `CRITICAL`, case-insensitive |
| `title` | yes (trigger) | ≤ 500 chars |
| `service` | no | Service slug. The API key already identifies the service; if sent, it must match (else `403`) |
| `description` | no | ≤ 5000 chars |
| `source` | no | Default `"api"` |
| `deduplicationKey` | no | Alerts with the same key group into one open incident. Default: hash of service + source + title with numbers masked |
| `metadata` | no | Any JSON object |
| `action` | no | `"trigger"` (default) or `"resolve"` |

`202 Accepted`:

```json
{
  "id": "alert_01M4V1JQA6G5TKEBVMPF8Z6DPZ",
  "status": "triggered",
  "receivedAt": "2026-10-13T16:29:54Z",
  "service": "checkout-api",
  "deduplicationKey": "checkout-errors",
  "decision": "incident_created",
  "reason": "Default rule: critical/high alerts open an incident",
  "incident": { "id": 2, "number": 2, "status": "triggered", "severity": "sev1", "alertCount": 1 }
}
```

- `id` — `alert_` + a [ULID](https://github.com/ulid/spec): unique, not guessable, sorts by time.
- `status` — `triggered`, or `suppressed` (matched a suppress rule, or service in maintenance).
- `incident.alertCount` — how many alerts the incident has grouped so far; a fourth repeat of the
  same problem answers `"decision": "grouped"` with `"alertCount": 4`.
- `decision` — `incident_created`, `grouped` (joined the open incident with the same key),
  `recorded` (no incident: by default `INFO`/`WARNING`), `suppressed`, `maintenance`, or `resolved`.

`{ "action": "resolve", "deduplicationKey": "checkout-errors" }` marks every triggered alert with that
key resolved (`id: null`, `status: "resolved"`, `resolvedCount`). If the service has `auto_resolve` and
the incident has no triggered alerts left, the incident is resolved too.

Errors: `400` invalid payload · `401` missing / unknown / revoked / expired key · `403` `service`
doesn't match the key · `422` `Idempotency-Key` reused with a different body · `429` rate limited ·
`503` database unavailable (`Retry-After: 5`; nothing was recorded, retry the same request).

**Idempotency.** Send `Idempotency-Key: <unique string>` (1–255 printable ASCII characters, e.g. the
monitoring tool's event id) to make retries safe: the first request's response is stored with the
alert, in the same transaction, and a repeat with the same key and body within 24 hours gets that
response back with `Idempotent-Replayed: true` and `"replayed": true`, recording nothing. Keys are
scoped to the service. The SDK sends one per call automatically. See
[failure handling](failure-handling.md#idempotency-step-by-step).

**Rate limiting.** Each key has a token bucket of `rate_limit_per_minute` (default 120): bursts up to
that many requests, refilled continuously. Every authenticated response carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the bucket is full);
a `429` adds `Retry-After`. Separately, an IP that sends 20 bad keys within a minute gets `429`
(`Retry-After: 60`) for the rest of that minute, even with a valid key.

### `GET /alerts?serviceId=&severity=&status=` — latest 200 alerts *(session)*

Newest first, with service slug, matched rule, the sending key's prefix and the incident number.

## Auth

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` | Sets cookie; returns `{ user, token }` |
| POST | `/auth/logout` | — | Clears cookie |
| GET | `/auth/me` | — | Current user + organization |

## Incidents

Incidents are addressed by their per-organization **number** (`INC-42` → `42`). Users who are an
*observer* on an incident get `403` from the endpoints that change it (status, severity, escalate,
notes) until they switch to responder.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/incidents?status=open\|all\|<status>&severity=&serviceId=` | — | Default `open` |
| POST | `/incidents` | `{ title, severity, serviceId?, description? }` | Declare manually; caller becomes commander |
| GET | `/incidents/:number` | — | Incident + `allowed_transitions`, alerts, timeline, `timeline_integrity`, responders, notifications, postmortem status |
| GET | `/incidents/:number/timeline` | — | Append-only timeline (`event_type`, `actor_id`, `metadata`, `prev_hash`, `hash`) + `integrity: { valid, events, first_invalid_id }`. No endpoint edits or deletes events |
| POST | `/incidents/:number/status` | `{ status, message? }` | `acknowledged`, `investigating`, `mitigated` or `resolved`, state-machine checked. `409 { error, from, to, allowed }` if not allowed |
| POST | `/incidents/:number/acknowledge` | — | Shorthand for `status: acknowledged` |
| POST | `/incidents/:number/escalate` | — | Page the next escalation step now (also after acknowledgement); the automatic schedule continues from there, still anchored to the trigger time. `409` when resolved, no policy, or every level already paged |
| POST | `/incidents/:number/severity` | `{ severity }` | `sev1`–`sev4` |
| POST | `/incidents/:number/notes` | `{ message }` | Timeline note |
| POST | `/incidents/:number/responders` | `{ userId?, role? }` | Join (omit `userId`) or add someone; `role`: `responder` (default), `observer` or `commander`. `201`, or `200 { changed: false }` if nothing changed |
| PATCH | `/incidents/:number/responders/:userId` | `{ role }` | Switch role / hand over command. Others' roles: commander or admin only |
| DELETE | `/incidents/:number/responders/:userId` | — | Leave, or remove someone (commander or admin). The commander must hand over first (`409`) |
| GET | `/incidents/:number/postmortem` | — | |
| POST | `/incidents/:number/postmortem` | — | Draft / refresh metrics + timeline (resolved incidents only) |
| PUT | `/incidents/:number/postmortem` | `{ summary?, impact?, rootCause?, resolution?, actionItems?, status? }` | `status: "published"` to publish |

## Services *(write operations: admin)*

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/services` | — | With status, open incident count, last alert |
| POST | `/services` | `{ name, slug?, description?, teamId?, escalationPolicyId?, autoResolve? }` | `slug` defaults to the name slugified ("Checkout API" → `checkout-api`). Returns the first API key's plaintext **once** in `apiKey.key` |
| PATCH | `/services/:id` | `{ description?, maintenance?, autoResolve?, escalationPolicyId? }` | `maintenance: true/false` |
| GET | `/services/:id/rules` | — | |
| PUT | `/services/:id/rules` | `{ rules: [{ name, conditions, action, incidentSeverity? }] }` | Replaces the ordered list |

Rule condition: `{ "field": "severity"|"source"|"title"|"description", "op": "equals"|"contains"|"at_least", "value": "…" }`
(`at_least` applies to `severity`). Actions: `create_incident`, `suppress`.

## API keys *(admin)*

Plaintext keys (`ir_live_` + 48 hex chars) are returned **only** by create and rotate. The database
stores a SHA-256 hash and a display prefix (`ir_live_a8f83e7c`).

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/services/:id/keys` | — | Prefix, name, `state` (`active` / `expiring` / `expired` / `revoked`), rate limit, `last_used_at`, `expires_at`, `revoked_at`, who created / revoked |
| POST | `/services/:id/keys` | `{ name?, rateLimitPerMinute? }` | New key, returned once in `apiKey.key` |
| POST | `/services/:id/keys/:keyId/rotate` | `{ graceMinutes? }` | Issues a replacement (same name and limit). The old key keeps working for `graceMinutes` (default 60, max 10080, `0` = stop now), then is rejected as expired. Returns `apiKey` and `previousKeyExpiresAt` |
| POST | `/services/:id/keys/:keyId/revoke` | — | Immediate: the next request with the key gets `401`. `409` if already revoked |

`last_used_at` has one-minute resolution: it is written at most once a minute per key.

## Postmortems

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/postmortems` | — | Every postmortem: incident, severity, `status`, `duration_seconds`, `action_items_done` / `action_items_total` |
| GET | `/incidents/:number/postmortem` | — | The document: `summary`, `impact`, `root_cause`, `resolution`, `what_went_well`, `what_went_poorly`, `action_items[{ id, description, owner, dueDate, done }]`, `metrics`, `timeline[{ eventId, hash, at, type, message, actor, hidden }]`, `status`, `published_at`, `published_by_name` |
| POST | `/incidents/:number/postmortem` | — | Draft it, or refresh metrics + timeline from the event log (written text and hidden entries are kept). `409` unless the incident is resolved |
| PUT | `/incidents/:number/postmortem` | `{ summary?, impact?, rootCause?, resolution?, whatWentWell?, whatWentPoorly?, actionItems?, hiddenTimelineEventIds?, status? }` | `status: "published"` publishes (`422` while the root cause is still the generated placeholder); once published, edits are `409` unless the same request sends `status: "draft"` (reopen) |
| PATCH | `/incidents/:number/postmortem/action-items/:id` | `{ done?, owner?, dueDate? }` | Allowed after publishing |
| GET | `/incidents/:number/postmortem/markdown` | — | `text/markdown` download, `INC-142-postmortem.md`; hidden timeline entries are left out; notes which sections were AI-assisted and who reviewed them |

`PUT` also takes `aiReviewed: true`: the reviewer confirms they reviewed the AI-assisted sections.
Publishing is `422` while `ai_review_pending` is true without it, and while the root cause still
starts with `[Unconfirmed AI hypothesis`.

### AI-assisted drafts

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/incidents/:number/postmortem/ai-drafts` | — | Latest 5: `status` (`queued`, `generating`, `ready`, `failed`, `applied`, `discarded`), `provider` (`claude` / `rules`), `model`, `output`, `warnings[{ section, message }]`, `usage`, `input_digest`, `input_events`, `applied_sections`, `error` |
| POST | `/incidents/:number/postmortem/ai-drafts` | — | `202 { draft }` and a worker job. `409` unless the incident is resolved, while the postmortem is published, or while another draft is generating |
| POST | `/incidents/:number/postmortem/ai-drafts/:id/apply` | `{ sections: [...] }` — any of `summary`, `impact`, `rootCause`, `resolution`, `whatWentWell`, `whatWentPoorly`, `actionItems` | Copies those sections into the postmortem (action items appended), marks them AI-assisted, sets `ai_review_pending`. `409` if the draft isn't ready or the postmortem is published |
| POST | `/incidents/:number/postmortem/ai-drafts/:id/discard` | — | `204` |

## Metrics

### `GET /metrics?days=7|30|90` *(session)*

Dashboard metrics for incidents **triggered** in the last `days` (default 30; anything else is `400`).

```json
{
  "window": { "days": 30 },
  "summary":  { "incidents": 37, "sev1": 6, "still_open": 0, "ack_timeouts": 2,
                "mtta_seconds": 222, "mttr_seconds": 2432,
                "tta_p50_seconds": 168, "ttr_p50_seconds": 2508, "ttr_p90_seconds": 3642 },
  "previous": { "...": "the same aggregates for the 30 days before" },
  "bySeverity": [{ "severity": "sev1", "incidents": 6, "mtta_seconds": 162, "...": "" }],
  "byService":  [{ "id": 1, "name": "Checkout API", "status": "operational", "incidents": 14, "sev1": 4,
                   "mttr_seconds": 2141, "open_incidents": 0, "...": "" }],
  "daily":  [{ "date": "2026-10-15", "sev1": 0, "sev2": 1, "sev3": 0, "sev4": 0 }],
  "active": [{ "number": 64, "title": "...", "severity": "sev1", "status": "triggered", "triggered_at": "...",
               "service_name": "Checkout API", "alert_count": 4 }]
}
```

MTTA is the mean of `acknowledged_at − triggered_at` over acknowledged incidents, MTTR the mean of
`resolved_at − triggered_at` over resolved ones. `bySeverity` always has all four severities;
`daily` has one UTC day per row, zeros included; `active` is every open incident, worst severity
first, then oldest. Scoped to the caller's organization.

## Simulator

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/demo` | — | `{ enabled, scenario: { name, description, steps[{ at, label }] }, run }` — `run` is the organization's current or just-finished simulation: `{ runId, startedBy, speed, step, total, label, done, results[{ label, decision, incident }] }` |
| POST | `/demo/simulate` | `{ speed?: 1 \| 2 \| 5 }` | Admin. `202`; the scenario's alerts go through ingestion over the next ~15 s (`speed` divides that). `409` while a run is in progress. Progress is pushed as `demo.progress` events on the live stream. `404` when `DEMO_ENABLED=false` |

## Escalation policies

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/escalation-policies` | — | Every policy with its ordered `steps` (`position`, `delayMinutes`, `targets[{ targetType, targetId, name }]`) and the `services` using it |
| GET | `/escalation-policies/:id` | — | One policy |
| POST | `/escalation-policies` | `{ name, description?, ackTimeoutMinutes?, steps: [{ delayMinutes, targets: [{ targetType: "user" \| "team", targetId }] }] }` | Admin. 1–10 steps, delays strictly increasing (0–1440), 1–10 targets per step, no duplicates; targets must be in your organization. `409` on a duplicate name |
| PUT | `/escalation-policies/:id` | same as POST | Admin. Replaces name, description and **all** steps in one transaction |
| DELETE | `/escalation-policies/:id` | — | Admin. `409` while a service still uses the policy |

`delayMinutes` counts from when the incident **triggered**, not from the previous step.
`ackTimeoutMinutes` (1–1440 or `null`) is the acknowledgement timeout: a SEV1/SEV2 incident not
acknowledged within it gets its next step paged immediately. Incidents expose the pending deadline as
`ack_deadline_at` and a missed one as `ack_timed_out_at`; `/stats` counts `ack_timeouts_30d`.

```json
{
  "name": "Checkout escalation",
  "ackTimeoutMinutes": 5,
  "steps": [
    { "delayMinutes": 0,  "targets": [{ "targetType": "team", "targetId": 1 }] },
    { "delayMinutes": 5,  "targets": [{ "targetType": "user", "targetId": 2 }] },
    { "delayMinutes": 10, "targets": [{ "targetType": "user", "targetId": 4 }] }
  ]
}
```

## Organization

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users` | Members of your organization |
| GET | `/teams` | With members |
| GET | `/stats` | Open / unacknowledged counts, 30-day MTTA and MTTR |
| GET | `/audit-log?before=<id>` | Admin only; 50 per page, keyset pagination via `nextBefore` |
| GET | `/stream` | Server-Sent Events: `incident.created`, `incident.updated`, `timeline.added`, `service.updated`, `alert.received` |

## Live updates

`GET /stream` *(session)* — Server-Sent Events for the caller's organization.

```
id: 1760429748123-0
data: {"type":"incident.updated","incidentId":2,"number":2,"status":"acknowledged","severity":"sev1","actor":"Sam Rivera"}
```

Event types: `incident.created`, `incident.updated`, `timeline.added`, `service.updated`,
`alert.received`; control messages `connected` and `resync` (re-fetch everything). Reconnect with the
`Last-Event-ID` header (browsers do this automatically) or `?lastEventId=` to replay missed events.

## Webhooks (admin)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/webhooks` | — | Endpoints with `events`, `enabled`, `disabled_reason`, `last_delivery`, `failures_24h` (never the secret) |
| POST | `/webhooks` | `{ url, description?, events? }` | `url` must be http(s); `events` defaults to all four. Returns `secret` (`whsec_…`) **once** |
| PATCH | `/webhooks/:id` | `{ url?, description?, events?, enabled? }` | Re-enabling clears `disabled_reason` |
| DELETE | `/webhooks/:id` | — | |
| POST | `/webhooks/:id/rotate-secret` | — | New secret, returned once |
| POST | `/webhooks/:id/test` | — | `202`; queues a signed `ping` |
| GET | `/webhooks/:id/deliveries` | — | Last 50: `event`, `status`, `attempts`, `response_status`, `duration_ms`, `last_error`, `payload` |
| POST | `/webhooks/deliveries/:id/redeliver` | — | `202`; resends the stored payload (same `id`). `409` while still queued |

What a receiver gets:

```http
POST /fireline HTTP/1.1
Content-Type: application/json
User-Agent: Fireline-Webhooks/1.0
Fireline-Event: incident.triggered
Fireline-Delivery: 17
Fireline-Signature: t=1760450538,v1=6f1c0e…

{
  "id": "evt_01M4X0Q7…",
  "event": "incident.triggered",
  "createdAt": "2026-10-14T14:02:18.000Z",
  "incident": {
    "id": "INC-142", "number": 142,
    "title": "Checkout API unavailable",
    "severity": "critical", "severityLevel": "sev1", "severityLabel": "SEV1 · Critical",
    "status": "triggered",
    "service": { "name": "Checkout API", "slug": "checkout-api" },
    "escalationLevel": 0,
    "url": "http://localhost:3000/incidents/142",
    "triggeredAt": "2026-10-14T14:02:18.000Z", "acknowledgedAt": null, "resolvedAt": null
  },
  "actor": null
}
```

Events: `incident.triggered`, `incident.acknowledged`, `incident.escalated`, `incident.resolved` (and
`ping` from *Send test*). Verify with `v1 = hex(HMAC-SHA256(secret, t + "." + rawBody))` and reject
timestamps older than 5 minutes (`verifyWebhookSignature()` in `@irp/shared/crypto` does both).
Delivery is at-least-once: dedupe on `id`. Any 2xx is success; other answers and timeouts (10 s) are
retried 5 times (5 s → 40 s backoff); `410 Gone` disables the endpoint.

## Background jobs (admin)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/queues` | Counts per queue (`notifications`, `escalations`, `webhooks`, `dead-letter`) by state, plus `workers`: live worker heartbeats (`id`, `startedAt`, `lastSeenAt`, `processed`, `failed`, `deadLettered`) |
| GET | `/admin/dead-letter` | Jobs that used up every retry, for your organization: original `queue`, `name`, `jobId`, `data`, `failedReason`, `attemptsMade`, `failedAt` |
| POST | `/admin/dead-letter/:id/retry` | Re-enqueue on the original queue (a failed page's notification row, or webhook delivery row, is reset to `queued` first). `409` if the page is no longer failed |
| DELETE | `/admin/dead-letter/:id` | Discard |

Retries and discards are written to the audit log.

## Health

`GET /health/live` (no auth) → `{ ok: true }` whenever the process is serving — the liveness probe.

`GET /health` (no auth, readiness) → `{ ok, status, acceptingAlerts, postgres, redis, sseClients, workers }`,
answered within ~2 s whatever is down:

| | HTTP | `status` | `acceptingAlerts` |
| --- | --- | --- | --- |
| all up | 200 | `ok` | `true` |
| Redis down | 200 | `degraded` | `true` — pages go out once Redis is back |
| Postgres down | 503 | `unavailable` | `false` |

`workers` is the number of workers with a fresh heartbeat; `0` doesn't fail the check (alerts are
still accepted, pages wait in Postgres). See [failure handling](failure-handling.md).
