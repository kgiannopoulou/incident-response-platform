# API reference

Base URL: `http://localhost:4000/api/v1`. JSON in and out. Errors are `{ "error": "message" }`
(validation errors add `details`).

Authentication:

- **Integration key** (alert ingestion only): `Authorization: Bearer <key>` or `X-Integration-Key: <key>`.
- **Session** (everything else): the `irp_session` httpOnly cookie set by `POST /auth/login`, or
  `Authorization: Bearer <token>` using the `token` returned by login.

## Alerts

### `POST /alerts` — ingest an alert *(integration key)*

```json
{
  "action": "trigger",              // or "resolve"; default "trigger"
  "summary": "Checkout API 5xx rate above 5%",
  "severity": "critical",           // critical | error | warning | info; default "error"
  "source": "prometheus:checkout-5xx",
  "component": "checkout-api",      // optional
  "dedupKey": "checkout-5xx",       // optional; derived from service + source + summary if omitted
  "details": { "error_rate": 0.23 } // optional, free-form
}
```

`202 Accepted`:

```json
{
  "alertId": 12,
  "dedupKey": "662c9ac7…",
  "decision": "incident_created",   // grouped | recorded | suppressed | maintenance | resolved
  "reason": "Default rule: critical/error alerts open an incident",
  "incident": { "id": 7, "number": 7, "status": "triggered" }
}
```

`action: "resolve"` marks every firing alert with that dedup key resolved. If the service has
`auto_resolve` and the incident has no firing alerts left, the incident is resolved.

### `GET /alerts?serviceId=` — latest 100 alerts *(session)*

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
| POST | `/incidents/:number/status` | `{ status, message? }` | State-machine checked; 409 if not allowed |
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
| POST | `/services` | `{ name, description?, teamId?, escalationPolicyId?, autoResolve? }` | Returns `integrationKey` **once** |
| PATCH | `/services/:id` | `{ description?, maintenance?, autoResolve?, escalationPolicyId? }` | `maintenance: true/false` |
| POST | `/services/:id/rotate-key` | — | Returns the new key once; the old key stops working |
| GET | `/services/:id/rules` | — | |
| PUT | `/services/:id/rules` | `{ rules: [{ name, conditions, action, incidentSeverity? }] }` | Replaces the ordered list |

Rule condition: `{ "field": "severity"|"source"|"summary"|"component", "op": "equals"|"contains"|"at_least", "value": "…" }`
(`at_least` applies to `severity`). Actions: `create_incident`, `suppress`.

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
