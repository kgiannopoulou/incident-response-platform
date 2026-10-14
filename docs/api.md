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
doesn't match the key · `429` rate limited.

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

Incidents are addressed by their per-organization **number** (`INC-42` → `42`).

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/incidents?status=open\|all\|<status>&severity=&serviceId=` | — | Default `open` |
| POST | `/incidents` | `{ title, severity, serviceId?, description? }` | Declare manually; caller becomes commander |
| GET | `/incidents/:number` | — | Incident + `allowed_transitions`, alerts, timeline, responders, notifications, postmortem status |
| POST | `/incidents/:number/status` | `{ status, message? }` | `acknowledged`, `investigating`, `mitigated` or `resolved`, state-machine checked. `409 { error, from, to, allowed }` if not allowed |
| POST | `/incidents/:number/acknowledge` | — | Shorthand for `status: acknowledged` |
| POST | `/incidents/:number/severity` | `{ severity }` | `sev1`–`sev4` |
| POST | `/incidents/:number/notes` | `{ message }` | Timeline note |
| POST | `/incidents/:number/responders` | `{ userId, role? }` | `role`: `responder` (default) or `commander` |
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

## Organization

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users` | Members of your organization |
| GET | `/teams` | With members |
| GET | `/escalation-policies` | With levels |
| GET | `/stats` | Open / unacknowledged counts, 30-day MTTA and MTTR |
| GET | `/audit-log?before=<id>` | Admin only; 50 per page, keyset pagination via `nextBefore` |
| GET | `/stream` | Server-Sent Events: `incident.created`, `incident.updated`, `timeline.added`, `service.updated`, `alert.received` |

## Health

`GET /health` (no auth) → `{ ok, postgres, redis, sseClients }`, 503 if a dependency is down.
