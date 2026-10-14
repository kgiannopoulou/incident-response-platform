# Architecture & design decisions

This document explains *why* the platform is built the way it is. The README covers what it does
and how to run it.

## Components

| Component | Responsibility | Talks to |
| --- | --- | --- |
| **API** (`apps/api`) | Validates and ingests alerts, owns every write to incidents/services/postmortems, serves the dashboard's REST endpoints and the SSE stream | Postgres (all writes in transactions), Redis (publish events, enqueue jobs, subscribe for SSE) |
| **Worker** (`apps/worker`) | Escalation policies, email pages, webhook deliveries, dead-lettering, periodic recovery sweep | Postgres, Redis (BullMQ consumer, publish events), SMTP, webhook receivers |
| **Web** (`apps/web`) | Dashboard for responders and admins | API only (REST + `EventSource`) |
| **Postgres** | Source of truth for everything, including "who still needs to be paged" | — |
| **Redis** | BullMQ queues and pub/sub for realtime events — *never* the only copy of anything important | — |

The API and worker are stateless and can be scaled horizontally: the API's SSE fan-out goes through
Redis pub/sub, and the worker's correctness relies on row locks, not on being the only worker.

## Alert ingestion

`POST /api/v1/alerts` takes `{ service, severity, title, description, source, deduplicationKey,
metadata }` and answers `{ id, status, receivedAt, … }`. Severities are `INFO`, `WARNING`, `HIGH`,
`CRITICAL` (case-insensitive). Alert ids are `alert_` + a ULID: unlike a SERIAL they don't reveal
volume or allow enumeration, and unlike a UUIDv4 they sort by creation time. API keys and rate
limiting run before any of this (next section).

Inside one transaction:

1. **Dedup key** — the client's `deduplicationKey`, or `sha256(service | source | normalized title)`.
   Normalization lower-cases, collapses whitespace and masks numbers, so
   `p99 latency 2300ms` and `p99 latency 2410ms` are the same alert.
2. **Maintenance** — alerts for a service in maintenance are stored as `suppressed`; nobody is paged.
3. **Grouping first** — if an open incident exists for `(service, dedup key)` the alert is attached
   to it (`SELECT … FOR UPDATE`), whatever the rules would say about a fresh alert.
4. **Rules** — the service's ordered rules (`packages/shared/src/rules.ts`, a pure function) decide:
   create an incident (optionally overriding severity), record only, or suppress. Default: CRITICAL
   and HIGH alerts open incidents (SEV1 / SEV2); WARNING and INFO are recorded.
5. **Create** — see the race below.

The endpoint returns `202 Accepted` with the decision (`incident_created`, `grouped`, `recorded`,
`suppressed`, `maintenance`, `resolved`) so integrations and tests can see exactly what happened.

## API keys

Machines authenticate with API keys, one or more per service (`api_keys` table).

- **Generated once, stored hashed.** A key is `ir_live_` + 192 random bits (48 hex chars). The
  plaintext exists in exactly one HTTP response — create or rotate — and the table keeps
  `sha256(key)` plus a display prefix (`ir_live_a8f83e7c`) so people can tell keys apart in the UI,
  audit log and alert records. A database dump yields no usable keys. SHA-256 rather than
  bcrypt/argon2 is deliberate: slow hashes protect *low-entropy* secrets from guessing; a 192-bit
  random key can't be guessed anyway, and a deterministic hash allows `WHERE key_hash = $1` on an
  index for every request. The recognisable prefix lets secret scanners flag a leaked key.
- **The key decides the service.** The `service` field in the body is optional; if present it must
  match the key's service (`403` otherwise), so a key can't post as another service or tenant.
- **Rotation with a grace period.** Rotating issues a replacement with the same name and limit and
  sets `expires_at = now() + graceMinutes` on the old key (default 60 minutes, `0` = immediately), so
  senders can roll the new key out without dropping alerts. `replaced_by_id` links the two.
- **Revocation** sets `revoked_at`: the next request gets `401 API key has been revoked`. Error
  messages distinguish unknown / revoked / expired, which costs nothing (the caller already holds
  the key) and saves on-call engineers a lot of guessing.
- **Last used.** `last_used_at` answers "is anything still using this key before I revoke it?".
  It's written at most once a minute per key (`… WHERE last_used_at < now() - interval '60 seconds'`),
  so a busy sender doesn't turn every alert into an extra row update and lock.
- Create, rotate and revoke are audited with the key prefix, never the key.

Migration `0002` moved the original single key per service into this table unchanged (same hash),
so existing senders kept working; a test-run against the populated dev database confirmed it.

## Rate limiting

Two limits, both in Redis so every API instance shares them (`apps/api/src/lib/rate-limit.ts`):

1. **Per key — token bucket.** Capacity = the key's `rate_limit_per_minute` (default 120), refilled
   continuously, so a sender can burst and then sustain limit/60 per second. Read-refill-take is one
   Lua script, so it's atomic under concurrency, and it uses Redis' `TIME` so API instances with
   skewed clocks agree. Responses carry `RateLimit-Limit` / `RateLimit-Remaining` /
   `RateLimit-Reset`; a `429` adds `Retry-After`, which the SDK waits for.
2. **Per IP — failed authentications.** 20 bad keys in a minute and that IP gets `429` before its key
   is even looked up, which makes guessing pointless and stops a misconfigured sender from hammering
   the database.

Both fail open: if Redis is down the request is allowed and the error logged. For an alerting
system, dropping alerts during an outage is worse than briefly not rate limiting.

### Correlation: alerts → incidents

Not every alert should become an incident. A failing check reports every minute:

```
10:31 checkout-api ERROR ┐
10:32 checkout-api ERROR │      INC-142  Checkout API elevated error rate
10:32 checkout-api ERROR ├────► Alerts: 4 · Severity: SEV1 · Status: triggered
10:33 checkout-api ERROR ┘      (paged once)
```

`apps/api/src/domain/correlation.ts` holds the logic, and it is deliberately the pseudo-code you'd
write on a whiteboard:

```ts
const existing = await findOpenIncident(db, service.id, dedupKey); // SELECT … FOR UPDATE
if (existing) await groupAlert(db, fx, existing, alert);
else await createIncident(db, fx, { …, dedupKey });
```

- **The correlation key is `(service, deduplicationKey)`.** Two services can both send
  `"db-errors"` without being merged. Without a client key, the derived hash above is used, so
  `p99 latency 2300ms` and `p99 latency 2410ms` still correlate.
- **Grouped alerts are first-class.** Each one is linked through `incident_alerts`, bumps
  `alert_count` and `last_alert_at`, and adds an `alert_attached` timeline entry; the incident page
  lists every alert with its metadata. Paging happens once, when the incident opens.
- **Severity follows the worst alert, upwards only.** `highest_alert_severity` remembers the most
  severe alert grouped so far. A strictly more severe alert (HIGH latency, then CRITICAL errors under
  the same key) raises the incident (SEV2 → SEV1, with a system `severity_changed` event and audit
  entry); repeats at an already-seen severity don't, so a responder who consciously downgrades an
  incident isn't overruled by the next copy of the same alert.
- **A resolved incident is closed for correlation.** The partial unique index below only covers open
  incidents, so the next alert for that key starts a new incident (a recurrence is a new event with
  its own timeline and postmortem).
- **Replays are idempotent.** Attaching the same alert twice is `ON CONFLICT DO NOTHING` and does not
  inflate the count.

`npm run simulate -- storm` plays this out against a running API.

### The duplicate-alert race

Monitoring systems fire bursts. Two identical alerts arriving together would both see "no open
incident" and both create one. The fix lives in the schema:

```sql
CREATE UNIQUE INDEX incidents_open_dedup_idx
  ON incidents (service_id, dedup_key)
  WHERE status <> 'resolved' AND dedup_key IS NOT NULL;
```

Creation uses `INSERT … ON CONFLICT (service_id, dedup_key) WHERE … DO NOTHING RETURNING *`. The
loser gets no row back, re-reads the winner's incident and groups its alert into it. Incident numbers
come from `UPDATE organizations SET incident_counter = incident_counter + 1 RETURNING …`, which
row-locks the organization and also serializes concurrent creations within a tenant. The integration
test fires 10 identical alerts in parallel and asserts one incident with `alert_count = 10`.

## Incident lifecycle

Statuses aren't free-form strings. The state machine is data, shared by API and UI
(`packages/shared/src/lifecycle.ts`):

```
TRIGGERED ──► ACKNOWLEDGED ──► INVESTIGATING ──► MITIGATED ──► RESOLVED
    │              │                 │                            ▲
    └──────────────┴─────────────────┴────────────────────────────┘   shortcuts to RESOLVED
```

```ts
export const INCIDENT_TRANSITIONS = {
  triggered: ["acknowledged", "resolved"],
  acknowledged: ["investigating", "resolved"],
  investigating: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: [],
};
```

- **Forward only.** Nothing returns to `triggered` or `acknowledged`; `resolved → acknowledged` is
  rejected with `409 Cannot move an incident from 'resolved' to 'acknowledged' ('resolved' is final)`.
  Error bodies carry `from`, `to` and `allowed`, so clients can explain the rejection.
- **`mitigated` means the bleeding stopped** (failover, rollback, feature flag) while the cause is
  still being fixed. A mitigated SEV1 moves its service from *outage* to *degraded*, and
  `mitigated_at` gives the postmortem a real impact window and a time-to-mitigate metric, separate
  from time-to-resolve.
- **`resolved` is final — no reopening.** If the problem comes back, the next alert opens a *new*
  incident (correlation only joins open incidents). Reopening would rewrite an incident whose metrics
  and postmortem were already computed; a recurrence is better modelled as its own incident.
  (The first version of this project allowed `resolved → investigating`; it was removed with this
  state machine.)
- **Skipping ahead keeps the metrics whole.** Resolving straight from `triggered` stamps
  `mitigated_at = resolved_at`, so "impact lasted until at least here" is always defined.
- **Enforced twice.** The API validates every move; a `BEFORE UPDATE OF status` trigger
  (migration `0004`) enforces the same table in Postgres, so a hand-written `UPDATE`, a script or a
  future code path that bypasses `changeStatus()` still can't produce an impossible transition. A test
  compares the two tables for all 25 `(from, to)` pairs, so they can't drift apart.

Every status change — from a responder, from `action: "resolve"` with auto-resolve, from the API —
goes through `changeStatus()` (`apps/api/src/domain/incidents.ts`), which:

- runs on an incident locked with `SELECT … FOR UPDATE`, so concurrent requests are serialized and
  the second "Acknowledge" gets a clean 409 instead of a double transition;
- stamps `acknowledged_at` / `mitigated_at` / `resolved_at` and clears `next_escalation_at`
  (stopping escalation);
- adds the actor as responder (commander if there is none);
- writes the timeline event and the audit entry;
- on resolve, queues "resolved" notifications to everyone who was paged and drafts the postmortem;
- recomputes the service's status from its remaining open incidents.

The UI never decides what's allowed: the incident detail response includes `allowed_transitions`.

## The incident page

`apps/web/src/app/incidents/[number]/page.tsx` is the screen responders live in during an incident,
split into `components/incident/*`:

- **Header** — `INC-142`, title, status, service health, commander and a severity banner; a facts
  strip (started, alerts + last alert, time to acknowledge / mitigate / resolve) that keeps counting
  while open; and the actions. Status buttons are rendered from `allowed_transitions`, so a resolved
  incident simply has none.
- **Escalate** pages the next level of the service's escalation policy immediately
  (`POST /incidents/:number/escalate`), including after acknowledgement, when the person on it needs
  more hands. It reuses the same rules as automatic escalation (unique page per person per level,
  delivery through the worker); on an unacknowledged incident the automatic schedule carries on from
  the new level.
- **Timeline** — oldest first, `14:02 🔴 Incident triggered … 14:13 🟢 Resolved`, with the note box
  underneath; **responders**, **paging** (who was paged at which level, delivery state), **alerts**
  (every grouped alert with its metadata) and the **postmortem** link alongside.

## Responders and roles

```
INC-142
Incident Commander   Konstantina
Responders           Maria, George
Observers            Alex
```

`incident_responders (incident_id, user_id, role, joined_at)`, roles `commander`, `responder`,
`observer` (`apps/api/src/domain/responders.ts`):

- **Exactly one commander.** A partial unique index (`… (incident_id) WHERE role = 'commander'`)
  makes two commanders impossible, even if two hand-overs race; handing over demotes the previous
  commander to responder in the same transaction and updates `incidents.commander_id`. The
  commander can't step down or leave without handing over, so an open incident never loses its owner.
  Whoever first acknowledges (or declares) an incident becomes commander if there is none.
- **Who may do what.** Anyone in the organization can join themselves as responder or observer,
  switch between the two, leave, or take command of an incident that has no commander. Changing
  someone else's role, removing them, or taking command from the current commander requires being the
  commander or an org admin.
- **Observers are read-only.** They follow along (support, management) but get `403` on status,
  severity, escalation and notes until they join as responder; the UI disables those controls and
  says why. Acting on an incident you're not on still adds you as a responder automatically.
- **Everything is on the timeline** — `RESPONDER_ADDED`, `RESPONDER_ROLE_CHANGED`,
  `COMMANDER_ASSIGNED`, `RESPONDER_REMOVED`, with `{ userId, from, to }` — and in the audit log.
  Postmortems count responders, not observers.
- Responders are frozen once the incident is resolved.

## Immutable timeline

Every important action becomes a row in `timeline_events (id, incident_id, actor_id, event_type,
message, metadata JSONB, created_at, prev_hash, hash)`:

| `event_type` | Written when | `metadata` |
| --- | --- | --- |
| `INCIDENT_CREATED` | an alert or a person opens the incident | `{ severity }` |
| `ALERT_ATTACHED` / `ALERT_RESOLVED` | a repeat alert is grouped / the monitor clears alerts | `{ alertId, severity, alertCount }` / `{ alertIds }` |
| `NOTIFICATION_SENT` / `INCIDENT_ESCALATED` | level 1 is paged / a later level is paged (worker or *Escalate*) | `{ level, userIds, manual? }` |
| `INCIDENT_ACKNOWLEDGED`, `STATUS_CHANGED`, `INCIDENT_RESOLVED` | any status change | `{ from, to }` |
| `SEVERITY_CHANGED` | by a person, or raised by a worse grouped alert | `{ from, to, reason? }` |
| `RESPONDER_ADDED`, `RESPONDER_ROLE_CHANGED`, `COMMANDER_ASSIGNED`, `RESPONDER_REMOVED` | people join, change role, take command, leave | `{ userId, from, to }` |
| `NOTE_ADDED`, `POSTMORTEM_GENERATED` | notes; postmortem drafted or refreshed | |

It is an **audit log, so it is append-only**, enforced at three levels:

1. **No API to change history.** `addTimeline()` is the only writer; there is no update or delete
   function and no `PUT`/`PATCH`/`DELETE` route (tests assert the 404s). Corrections are new events.
2. **The database refuses.** `BEFORE UPDATE` / `BEFORE DELETE` triggers raise
   `timeline_events is append-only`, whoever is connected — the API, the worker or someone with
   `psql`. Deleting an entire incident still works: the delete guard only fires while the parent
   incident exists, so `ON DELETE CASCADE` goes through.
3. **Tampering is evident.** Each event stores `hash = sha256(prev_hash ‖ incident ‖ type ‖ actor ‖
   message ‖ metadata ‖ created_at)`, chained per incident in insertion order (a `BEFORE INSERT`
   trigger computes it, locking the incident row so concurrent appends can't fork the chain).
   `timeline_verify(incident_id)` walks the chain and returns the first event that no longer matches.
   The incident page shows *🔒 chain verified* or *⚠ chain broken at event #N*. Tests disable the
   triggers as a table owner, rewrite a note or delete an event, and assert that verification
   pinpoints it.

What the chain does *not* do: someone who can rewrite rows can also recompute every later hash.
Anchoring the latest hash somewhere they can't write (an external log, a signed daily digest) would
close that gap; it's on the production list below.

Migration `0005` renamed the vocabulary to `SCREAMING_SNAKE_CASE`, the columns to `event_type` /
`actor_id`, added a `CHECK` on known event types, and backfilled the chain for existing events.

## Side effects after commit

Publishing "incident created" to browsers or enqueuing a page *before* the transaction commits
risks announcing something that then rolls back. Domain functions therefore record effects on an
`Effects` collector (`apps/api/src/lib/effects.ts`); `runTx()` flushes it only after `COMMIT`.

The opposite failure — commit succeeded, process died before flushing — is covered by the next point.

## Escalation policies

```
Checkout escalation                       escalation_policies
  0 min                         → Payments team      │ 1..n, ordered by position
  2 min without acknowledgement → Alex (team lead)   ▼
  5 min without acknowledgement → Riley (eng. mgr)  escalation_steps (position, delay_minutes)
                                                     │ 1..n
                                                     ▼
                                                    escalation_step_targets (target_type user|team)
```

- **Delays are measured from the trigger time**, not from the previous step. The policy then reads
  top to bottom exactly as people describe it ("after 10 minutes the manager gets paged"), and one
  late page (a worker restart) doesn't push every later step back. A step whose time has already
  passed is due immediately (`escalationDueAt()`).
- **Targets are users or teams.** The API speaks `{ targetType, targetId }`; the table keeps one real
  foreign key per type plus a `CHECK`, rather than a polymorphic id, so deleting a user or team can't
  leave a dangling target. A team target pages every member; someone reachable through two targets
  of the same step is paged once.
- **Validation in one place.** `escalationPolicySchema` (`@irp/shared`) requires 1–10 steps with
  strictly increasing delays and no duplicate targets; the API additionally checks every target
  belongs to the caller's organization. A `UNIQUE (policy_id, delay_minutes)` backs the ordering rule.
- **Whole-policy writes.** `PUT` replaces name, description and all steps in one transaction and
  one audit entry, so a policy is never observed half-edited and the audit log says exactly what it
  became.
- **One paging routine.** Automatic escalation (worker), the *Escalate* button (API) and, later,
  acknowledgement timeouts all call `pageNextEscalationStep()` in `@irp/database`, which creates the
  notification rows, advances `escalation_level` and schedules the following step.
- A policy can't be deleted while a service uses it (`409` naming the services).

## Acknowledgement timeout

```
Incident created (SEV1)
      │  ack_deadline_at = now + 5 min      escalations.add("ack-timeout", { incidentId },
      ▼                                                     { jobId: "ack-timeout-<id>", delay: 5 min })
 wait 5 minutes
      │
      ▼
 acknowledged? ── yes ──► changeStatus() clears ack_deadline_at; after COMMIT the API removes the job
      │ no
      ▼
 worker: ACK_TIMEOUT on the timeline, page the next step now, webhook incident.escalated
```

Escalation steps are the *regular* schedule; the acknowledgement timeout is a *fast lane* for
high-urgency incidents. With steps at 0 / 10 / 20 minutes and a 5-minute timeout, an unowned SEV1
pages step 2 at minute 5; step 3 still follows at minute 20. Low-urgency incidents (SEV3/SEV4) only
follow the steps.

- **Why a delayed job here.** "Do X in 5 minutes unless Y happens first" is exactly what delayed jobs
  are for. The job has a deterministic id (`ack-timeout-<incidentId>`), so scheduling it twice is a no-op
  and acknowledging can cancel it with `queue.remove(id)` — after COMMIT, so a rolled-back
  acknowledgement never cancels anything.
- **Cancellation is an optimisation, not the guarantee.** A job that's already running can't be
  removed; `handleAckTimeout()` row-locks the incident and acts only if it is still `triggered` with a
  deadline in the past, clearing the deadline as it acts. So a late or duplicate job, or the sweeper
  racing the job, does nothing (tested with all three at once).
- **Postgres stays the source of truth.** `ack_deadline_at` is on the incident; the sweeper handles
  overdue deadlines whose job Redis lost.
- **Severity changes move the clock.** A SEV3 raised to SEV1 (by a correlated CRITICAL alert or a
  person) gets a deadline from that moment; a SEV1 lowered to SEV3 loses it. The timeout fires at most
  once per incident (`ack_timed_out_at`), after which the regular steps take over.
- It's measurable: missed timeouts count on the dashboard, and the postmortem's escalation count and
  "review on-call coverage" action item pick them up from the timeline.

## Postgres as the source of truth for paging

A queue is a great trigger and a poor ledger. So:

- **Escalation state lives on the incident**: `escalation_level` (last level paged) and
  `next_escalation_at` (when the next level is due; `NULL` = nothing to do).
- **Notifications are rows** with `queued → sent | failed`, attempts and last error.
- Queue jobs carry only ids; the worker always re-reads current state.
- A **sweeper** (an in-process timer in every worker, every 10 s) escalates anything with
  `next_escalation_at <= now()` and re-enqueues notifications stuck in `queued`. It is deliberately
  *not* a BullMQ repeatable job: a scheduler stored in Redis would vanish together with the queue
  state it is meant to recover.

So if Redis is flushed, or the API crashes between COMMIT and enqueue, a page is delayed by seconds,
never lost. Duplicates are harmless because every step is idempotent:

- `escalateIncident()` locks the incident and acts only if the step is still due — five concurrent
  calls page once (tested);
- `notifications_once_per_level_idx` makes a person's page per level unique;
- delivery only sends rows still `queued`, and BullMQ job ids (`notification-<id>`) dedupe the queue.
  Finished jobs are removed rather than retained, so that dedup only applies to jobs still in flight
  (a retained completed job would make BullMQ silently drop a later job with the same id — a bug the
  worker test suite reproduces).

Delivery failures are retried with exponential backoff (5 attempts); the row is marked `failed` with
the error after the last one and shown in the incident's paging panel.

## Background jobs: Redis + BullMQ

```
API ─┬─ save incident (COMMIT)
     └─ escalations.add("incident-created", { incidentId })      ← the request returns here
                         │
                         ▼   Redis
                      worker ── pages step 1: notification rows ──► notifications.add("deliver")
                         │                                               │ 5 attempts, 2 s → 16 s
                         │ escalations.add("escalate", delay)            ▼
                         ▼ (delayed job = next step)                 email / webhook
                      worker ...                                         │ last attempt failed
                                                                         ▼
                                                                    dead-letter queue
```

- **The HTTP request never waits for a page.** It commits the incident and enqueues an
  `incident-created` job (after COMMIT, see above); a worker pages the first step.
- **One retry policy per queue** (`RETRY_POLICY` in `@irp/shared/jobs.ts`), used by every producer:
  pages get 5 attempts with exponential backoff (2, 4, 8, 16 s); escalation steps 5 attempts from 1 s.
  Previously only deliveries retried; an escalation step that hit a transient database error now
  retries too instead of waiting for the sweeper.
- **Dead-letter queue.** When a job fails its *last* attempt, the worker copies it — original queue,
  job name and id, data, error, attempts, and the organization it belongs to — into the
  `dead-letter` queue, which no worker consumes. Admins see it on the **System** page and can
  **retry** (re-enqueue on the original queue; a page's notification row is reset to `queued` first,
  because delivery only sends `queued` rows) or **discard**. Both are audited. Failed jobs are not
  kept in their original queues (`removeOnFail`), so the dead-letter queue is the one place to look.
- **Tenant scoping.** Queues are shared infrastructure, so counts on the System page are
  platform-wide, but dead letters carry their `organizationId` and are only listed and retried
  for that organization.
- **Worker heartbeats.** Each worker refreshes `irp:worker:<host>:<pid>` (TTL 30 s) every 10 s with
  processed / failed / dead-lettered counters. `/health` reports how many are alive; a crashed worker
  drops off within 30 s. No worker is not an API outage: alerts are still accepted and pages wait in
  Postgres for the sweeper.
- **Graceful shutdown.** `SIGTERM` stops the sweeper, lets in-flight jobs finish (`Worker.close()`),
  removes the heartbeat and closes connections; a hard kill is covered by BullMQ's stalled-job
  recovery plus idempotent jobs.

## Notifications: email and webhooks

Two channels, for two audiences:

| | Email | Webhook |
| --- | --- | --- |
| For | a person being paged | a system (chat bot, ticketing, status page) |
| Row | `notifications` (one per person per escalation step) | `webhook_deliveries` (one per endpoint per event) |
| Written by | escalation (`pageNextEscalationStep`), resolve | `queueWebhookEvent()` on triggered / acknowledged / escalated / resolved |
| Sent by | worker, `notifications` queue, nodemailer SMTP | worker, `webhooks` queue, `fetch` |
| Retries | 5 × (2 s → 16 s) | 5 × (5 s → 40 s) |

- **Outbox, not fire-and-forget.** Both are rows inserted *in the transaction* that caused them, then
  delivered by a job enqueued after COMMIT; the sweeper re-drives rows still `queued` after 30 s. So a
  webhook can't announce an acknowledgement that rolled back, and a crash between COMMIT and enqueue
  delays a delivery instead of losing it.
- **The payload is frozen at the event.** The JSON body (with a unique `evt_<ULID>` id) is stored on
  the delivery row and sent byte-for-byte on every attempt and on manual *Redeliver*, so a retry
  three minutes later still describes the incident as it was when the event happened, and receivers
  can dedupe on `id` (delivery is at-least-once).
- **Signed.** `Fireline-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>` — the
  Stripe-style scheme: the timestamp is inside the MAC, so a captured request can't be replayed after
  the 5-minute window; verification uses a constant-time compare. The secret (`whsec_…`) is shown once;
  unlike API keys it can't be stored as a hash because the worker needs it to sign.
- **Being a good webhook citizen.** 10 s timeout, `redirect: "manual"`, any 2xx is success, `410 Gone`
  disables the endpoint (with the reason shown in the UI) instead of retrying forever.
- **SSRF.** Webhook URLs are user-supplied, and the worker runs inside the network. With
  `WEBHOOK_BLOCK_PRIVATE_NETWORKS=true` the worker resolves the host and refuses loopback, RFC 1918,
  link-local (cloud metadata `169.254.169.254`), CGNAT and unique-local IPv6 targets before
  connecting, and doesn't follow redirects. It's off locally so a receiver on `localhost` works.
- **Email** renders a subject that works on a lock screen (`[SEV1 · Critical] New incident: INC-142
  Checkout API unavailable (Checkout API)`) plus text and HTML bodies with a link to the incident;
  the SMTP `Message-ID` is stored on the row. Without `SMTP_URL` the worker logs instead of sending.
  Docker compose runs **Mailpit** so every page is visible at http://localhost:8025.
- Integrations such as Slack or Teams are deliberately *not* built in: they are a webhook receiver
  away, and the delivery architecture (outbox, signing, retries, DLQ) is the part worth getting right.

## Realtime updates

Open the same incident in two windows. When window A acknowledges, window B changes from
**TRIGGERED** to **ACKNOWLEDGED** immediately, with a "Alex Morgan updated this incident" notice, and
no refresh.

**Why SSE rather than WebSockets.** Incident dashboards mostly *consume* server-generated updates;
everything the browser *does* is already a REST call with validation, auth and audit. Server-Sent
Events are plain HTTP (the session cookie, CORS, proxies and the auth middleware just work), and
the browser's `EventSource` brings automatic reconnection and `Last-Event-ID` for free. A
bidirectional socket would add a second protocol to secure without a use for the extra direction.

```
API / worker ──EVAL──► Redis: XADD irp:stream:org:<id>  (id 1760429748123-0, last ~1000 kept)
                              PUBLISH irp:events:org:<id> "1760429748123-0 {json}"
                                        │ pattern subscription, one per API process
                                        ▼
                              RealtimeHub ──► id: 1760429748123-0
                                              data: {"type":"incident.updated","number":2,
                                                     "status":"acknowledged","actor":"Sam"}
```

- **One publish path.** API and worker both call `publishRealtime()` (`@irp/shared/realtime`), a
  Lua script that appends the event to the organization's Redis Stream and publishes it on the
  organization's channel *atomically*, so pub/sub order always matches stream order even with many
  publishers. Only after `COMMIT` (see below).
- **Tenant isolation.** One channel and stream per organization; each SSE connection only receives
  its organization's events (tested).
- **No missed updates across reconnects.** Every SSE message has `id:` = its stream id. On a
  short drop `EventSource` reconnects and sends `Last-Event-ID`; the hub replays the events after it
  from the stream (`XRANGE (id +`) and only then switches the connection to live messages — live
  messages arriving during the replay are held and de-duplicated, so nothing is lost or reordered in
  between. If the API was down long enough for the browser to give up, the client opens a new
  `EventSource` with backoff and passes `?lastEventId=`.
- **Resync when history is gone.** If the requested id is no longer in the (capped) stream, the
  server sends `{"type":"resync"}` and every live view re-fetches. Delivery is therefore
  *at-least-once*: a hint may arrive twice, which is harmless.
- **Hints, not state.** Events are small "something changed" hints; clients re-fetch the resource
  so the REST API stays the single source of truth. Incident events also carry the new `status` /
  `severity` and the `actor`, which the incident page applies instantly while its re-fetch is in
  flight, and uses for the "updated by" notice.
- Heartbeat comments every 25 s keep proxies from closing idle streams; `retry: 3000` sets the
  browser's reconnect delay. `/health` reports the number of open SSE connections.

## Multi-tenancy and authorization

Every business table has `organization_id`; every query filters on the organization from the JWT
(or from the API key). Incident routes use the per-organization number (`INC-42`), so
tenant B's `INC-1` is a different incident from tenant A's `INC-1`, and there is no global id to guess.
Cross-references (adding a responder, choosing a team or escalation policy) are checked to belong to
the same organization. Roles: `admin` manages services, rules and keys and can read the audit log;
`responder` works incidents. Tests cover isolation for REST, ingestion and SSE.

Sessions are JWTs in an httpOnly, `SameSite=Lax` cookie (`Secure` when `COOKIE_SECURE=true`), with
`Authorization: Bearer` accepted for scripts.

## Postmortems

```
timeline_events (append-only, hash-chained)          postmortems.timeline
  #801 INCIDENT_CREATED       h=3f9a…   ──────────►  14:02 🔴 Incident opened by alert from prometheus
  #802 ALERT_ATTACHED         h=b21c…   ┐
  #803 ALERT_ATTACHED         h=77d0…   ┴─────────►  14:02 🔔 2 more alerts grouped into the incident
  #806 INCIDENT_ACKNOWLEDGED  h=0c4e…   ──────────►  14:03 👤 Acknowledged — Sam
  #807 RESPONDER_ADDED                     (left out: housekeeping)
  #809 NOTE_ADDED             h=a8f1…   ──────────►  14:07 💬 Database connections appear exhausted — Sam
  ...                                               { eventId: 809, hash: "a8f1…", hidden: false }
```

When an incident resolves, `buildPostmortemDraft()` (a pure function over the incident, its alerts,
timeline and responders) produces the whole document, and the earlier design decisions pay off:

- **The timeline is curated from the immutable log, not retyped.** `curateTimeline()` keeps the events
  that tell the story (pages, escalations, acknowledgement timeouts, status and severity changes,
  notes, resolution), collapses runs of grouped alerts into one line, and drops housekeeping. Each
  entry keeps its source `eventId` and `hash`, so any line of a postmortem can be checked against the
  hash-chained audit log. Responders can **hide** an entry from the document — never edit its time or
  wording — and a *Refresh data* rebuild keeps those choices (`mergeTimelineVisibility()`).
- **Facts pre-fill the retrospective.** Metrics (duration, time to acknowledge / mitigate / resolve,
  alerts, escalations, ack timeouts, notes, responders), a summary, impact window, the first signal as
  a root-cause starting point, the resolution message, *what went well* ("acknowledged within 2m",
  "mitigated before the full fix") and *what went poorly* ("nobody acknowledged within the
  acknowledgement timeout"), plus suggested action items.
- **Publishing is a state, not a flag.** Publishing requires a real root cause (the generated
  placeholder is rejected), stamps `published_at` / `published_by` and adds a `POSTMORTEM_PUBLISHED`
  event to the incident's timeline. The narrative is then read-only; reopening as a draft is explicit
  and audited. Action items have stable ids and can be ticked off with a `PATCH` after publishing,
  because follow-up work happens after the review meeting.
- **Export.** `renderPostmortemMarkdown()` renders the document (header table, sections, `[ ]`/`[x]`
  action items) for a wiki or a PR.

## What I'd do next for production

- **Outbox table** instead of post-commit flush + sweeper, if more event types need guaranteed delivery.
- **Partitioning / retention** for `alerts`, `timeline_events` and `audit_log`.
- **Anchor the timeline hash chain** externally (e.g. publish each incident's head hash to a write-once
  store) so even a database superuser can't rewrite history undetected.
- **Scoped keys** (trigger-only vs. resolve) and per-organization quotas on top of per-key limits.
- **On-call schedules** (rotations) as a third escalation target type next to users and teams.
- **OpenTelemetry** traces across API → queue → worker.
