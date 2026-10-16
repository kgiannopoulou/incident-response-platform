# Fireline — Incident Response Platform

[![CI](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/codeql.yml/badge.svg)](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/codeql.yml)

A self-hosted incident-management platform for receiving monitoring alerts, correlating them into
incidents, coordinating responders, managing escalations, investigating causes and producing
postmortems.

Built to explore the engineering behind production incident-management systems — deduplication
under concurrency, a state machine enforced twice, an append-only audit trail, paging that survives
a lost queue, real-time updates with replay, multi-tenant isolation, and AI used where it can be
checked — rather than simply reproducing their UI.

> *"Our checkout service is down."* Follow it from the first automated alert → incident → page →
> escalation → acknowledgement → investigation → resolution → postmortem, in one `docker compose up`.

![Simulating a production incident on the dashboard](docs/screenshots/simulate-incident.gif)

*▶ Simulate production incident: CPU and latency warnings, checkout failures grouped and raised to a
SEV1, the database running out of connections — every alert through the real ingestion pipeline,
the dashboard updating live over SSE.*

![AI Incident Investigator](docs/screenshots/investigation.jpg)

*The incident investigator on the same incident: it found the `v2.14.0` deploy six minutes before
the first alert, the new connection-pool errors after it, and Postgres running out of connections as
the likely symptom — every claim backed by evidence chips, and a timeline that starts before the
incident did.*

## Contents

[Features](#features) · [Architecture](#architecture) · [Incident lifecycle](#incident-lifecycle) ·
[Alert ingestion](#alert-ingestion) · [Deduplication](#deduplication-strategy) ·
[Background jobs](#background-jobs) · [Real-time](#real-time-architecture) · [AI](#ai-used-carefully) ·
[Database](#database-design) · [Security](#security) · [Failure handling](#failure-handling) ·
[Running locally](#running-locally) · [API](#api-documentation) · [Testing](#testing) ·
[CI/CD](#cicd) · [Engineering decisions](#engineering-decisions)

## Features

| | |
| --- | --- |
| **Alert ingestion** | `POST /api/v1/alerts` with per-service API keys (hashed), four severities, deduplication keys, metadata, PagerDuty-style `resolve`, `Idempotency-Key`, per-key rate limits |
| **Correlation** | Repeats join the open incident (`Alerts: 4`); a worse repeat raises severity; matching rules per service (open / record only / suppress); maintenance windows |
| **Incident lifecycle** | `triggered → acknowledged → investigating → mitigated → resolved`, validated in the API *and* a Postgres trigger, row-locked against double clicks |
| **Responders** | Exactly one Incident Commander (database-enforced), responders, read-only observers, hand-over |
| **Escalation** | Ordered policies (`0 min → team, 5 min → lead, 10 min → manager`), user and team targets, acknowledgement timeout for SEV1/SEV2 as a cancellable delayed job, *Escalate* on demand |
| **Notifications** | Email pages (Mailpit locally) and HMAC-signed webhooks with a delivery log, retries, dead-letter queue, SSRF guard; SDK helper to verify them |
| **Timeline** | Typed, append-only, hash-chained audit log of every action; tampering is detectable |
| **Real-time** | Server-Sent Events through Redis, with event ids and replay after reconnect |
| **AI Incident Investigator** | Correlates alerts, deployments, log patterns and dependencies into ranked, evidence-backed hypotheses and a reconstructed timeline — a Claude agent over read-only tools, or offline rules |
| **Postmortems** | Drafted from the immutable timeline on resolve; AI-assisted draft as a reviewed suggestion with checked citations; publish, action items, Markdown export |
| **Dashboard** | Active incidents, MTTA / MTTR over 7 / 30 / 90 days, per day / service / severity, service health |
| **Simulator** | `npm run demo:incident` or a dashboard button: a whole outage — deploys, logs, alerts, responders |
| **SDK** | [`@incident-platform/sdk`](packages/alert-sdk): `alert`, `resolve`, `captureException`, `monitor`, `deployment`, `logs`, webhook verification; zero dependencies |
| **Operations** | `docker compose up` for everything, health/readiness checks, worker heartbeats, System page with queues and dead letters, graceful shutdown |

<details>
<summary><b>More screenshots</b></summary>

![Incident page](docs/screenshots/incident-page.jpg)

*The incident page: state-machine actions, the investigator, the live hash-verified timeline,
responders by role, paging and grouped alerts.*

![Dashboard](docs/screenshots/dashboard.jpg)

| AI postmortem draft — a suggestion with cited events | Review gate after applying sections |
| --- | --- |
| ![AI draft](docs/screenshots/postmortem-ai-draft.jpg) | ![AI review](docs/screenshots/postmortem-ai-review.jpg) |
| **Escalation, live** | **Acknowledgement timeout countdown** |
| ![Incident with escalation](docs/screenshots/incident-escalation.jpg) | ![Acknowledgement timeout](docs/screenshots/incident-ack-timeout.jpg) |
| **Escalation policies** | **Signed webhooks with a delivery log** |
| ![Escalation policies](docs/screenshots/escalation-policies.jpg) | ![Webhooks](docs/screenshots/webhooks.jpg) |
| **Background jobs and the dead-letter queue** | **Alert feed** |
| ![System](docs/screenshots/system.jpg) | ![Alerts](docs/screenshots/alerts.jpg) |
| **API keys: rotation and revocation** | **A published postmortem** |
| ![API keys](docs/screenshots/api-keys.jpg) | ![Postmortem](docs/screenshots/postmortem.jpg) |

</details>

## Architecture

```mermaid
flowchart LR
  subgraph clients[" "]
    MON["Monitoring tools /<br/>apps with the SDK"]
    CI["CI/CD"]
    BR["Browser"]
  end
  MON -- "POST /alerts, /logs<br/>API key" --> API
  CI -- "POST /deployments<br/>API key" --> API
  BR -- "HTTPS + cookie" --> WEB["apps/web<br/>Next.js"]
  BR -- "REST + SSE" --> API["apps/api<br/>Express"]
  API -- "SQL, one transaction<br/>per change" --> PG[("PostgreSQL<br/>source of truth")]
  API -- "job ids after COMMIT,<br/>pub/sub + stream" --> RD[("Redis<br/>BullMQ, SSE fan-out,<br/>rate limits")]
  RD <--> WK["apps/worker<br/>escalation · notifications ·<br/>webhooks · AI drafts ·<br/>investigations · sweeper"]
  WK --> PG
  WK -- "email" --> SMTP["SMTP / Mailpit"]
  WK -- "signed POST" --> HOOK["Webhook receivers"]
  WK -- "redacted context" --> CL["Claude API<br/>(optional)"]
```

| Path | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Express 5 + TypeScript REST API: ingestion, incidents, services, escalation, postmortems, investigations, audit log, SSE |
| [`apps/worker`](apps/worker) | BullMQ worker: escalation, email and webhook delivery, AI drafts, the investigator, the recovery sweeper |
| [`apps/web`](apps/web) | Next.js 16 (App Router) + Tailwind dashboard |
| [`apps/simulator`](apps/simulator) | `npm run demo:incident` and smaller scenarios, sent over HTTP with the SDK |
| [`packages/database`](packages/database) | Plain-SQL migrations (13), runner, seed, pool + transaction helper, test fixtures |
| [`packages/shared`](packages/shared) | Domain types, zod schemas, state machine, rules, dedup, postmortem generator, investigator engine (pure, unit-tested) |
| [`packages/alert-sdk`](packages/alert-sdk) | `@incident-platform/sdk`, the publishable client |
| [`docs`](docs) | [Architecture & decisions](docs/architecture.md) · [Threat model](docs/threat-model.md) · [Incident lifecycle](docs/incident-lifecycle.md) · [Failure handling](docs/failure-handling.md) · [API](docs/api.md) · [Testing](docs/testing.md) |

Stack: TypeScript everywhere, Node.js 22, Express 5, PostgreSQL 16 (raw SQL via `pg`), Redis 7,
BullMQ, Next.js 16 / React 19, Tailwind 4, zod, Anthropic SDK, Vitest, Docker Compose, GitHub Actions.

## Incident lifecycle

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
  resolved: [], // final: a recurrence is a new incident
};
```

Every move goes through one function, `changeStatus()`: it row-locks the incident, checks the shared
state machine (a Postgres trigger enforces the same table — a test keeps them identical), stamps
`acknowledged_at` / `mitigated_at` / `resolved_at` (MTTA, MTTR), stops escalation, writes the
timeline event and the audit entry, and on resolve pages everyone who was paged and drafts the
postmortem. `resolved → acknowledged` is a `409` with the allowed moves in the body. The full walk
from alert to postmortem is in [docs/incident-lifecycle.md](docs/incident-lifecycle.md).

## Alert ingestion

```
Monitoring tool ──POST /api/v1/alerts──► API key (SHA-256 lookup) ─► rate limit (Redis token bucket)
                  Authorization: Bearer ir_live_…  Idempotency-Key: …       │
                                                                            ▼
                                     idempotency check ─► maintenance? ─► open incident with this key?
                                                                     yes ──► group into it
                                                                     no  ──► matching rules (ordered)
                                                       create incident · record only · suppress
                                                                            │
                                                   after COMMIT: paging job, SSE event, service status
```

```sh
curl -X POST http://localhost:4000/api/v1/alerts \
  -H "Authorization: Bearer ir_live_dev_checkout_api" \
  -H "Content-Type: application/json" \
  -d '{"service":"checkout-api","severity":"critical","title":"Checkout error rate exceeded threshold",
       "description":"Error rate reached 38%","source":"prometheus","deduplicationKey":"checkout-errors",
       "metadata":{"errorRate":38,"region":"eu-west-1"}}'
```

```json
{
  "id": "alert_01M4V1JQA6G5TKEBVMPF8Z6DPZ", "status": "triggered", "receivedAt": "2026-10-13T16:29:54Z",
  "service": "checkout-api", "deduplicationKey": "checkout-errors", "decision": "incident_created",
  "reason": "Default rule: critical/high alerts open an incident",
  "incident": { "id": 64, "number": 64, "status": "triggered", "severity": "sev1", "alertCount": 1 }
}
```

`INFO` / `WARNING` are recorded, `HIGH` / `CRITICAL` open SEV2 / SEV1 incidents unless a rule says
otherwise. API keys (`ir_live_` + 192 random bits) are shown once and stored only as SHA-256, with
rotation (grace period), instant revocation and throttled last-used timestamps. The same keys report
**deployments** (`POST /deployments`) and **logs** (`POST /logs`) — evidence for the investigator.

## Deduplication strategy

Four `checkout-errors` alerts are one incident with `Alerts: 4`, not four pages.

- The key is the sender's `deduplicationKey`, or — if it sends none — a fingerprint of service +
  source + title with numbers masked (`CPU 91%` and `CPU 94%` are the same problem).
- **The database settles races.** A partial unique index allows one *open* incident per
  `(service, dedup_key)`. Concurrent alerts `INSERT … ON CONFLICT DO NOTHING`; the loser re-reads
  and joins the winner. 100 identical alerts in flight at once → 1 incident, 100 attached alerts,
  one page (tested — and that test found a deadlock, fixed with `FOR NO KEY UPDATE`).
- A more severe repeat raises the incident's severity (never lowers it) and starts the
  acknowledgement clock if it became a SEV1/SEV2.
- Separately, `Idempotency-Key` makes the *same request* sent twice record one alert, not two.

## Background jobs

```
API ── save incident (COMMIT) ──► escalations: "incident-created" { incidentId }
                                       │  worker pages step 1, schedules step 2 as a delayed job
                                       │  + "ack-timeout" (delayed, removed on acknowledge)
                                       ▼
                                  notifications: "deliver" { notificationId }    email
                                  webhooks: "deliver-webhook" { deliveryId }       signed POST
                                       │  retries with exponential backoff
                                       ▼  still failing → dead-letter queue (inspect / retry / discard)
API ── "Generate AI draft" ──► ai-drafts        API ── "Investigate" ──► investigations
```

The HTTP request never waits for email, webhooks or a model. Jobs carry only ids — the worker
re-reads current state — and are idempotent: escalation steps row-lock and re-check, deliveries take
a lease and only send rows still `queued`. Per-queue retry policies, a dead-letter queue with
tenant-scoped retry, worker heartbeats on `/health` and the System page, and a sweeper (every 10 s)
that re-drives anything Postgres says is due, so a lost job delays work by seconds instead of losing it.

## Real-time architecture

Open an incident in two windows, acknowledge in one: the other flips from TRIGGERED to ACKNOWLEDGED
instantly ("Alex Morgan updated this incident").

```
API / worker ── one Lua script: XADD to a capped per-org Stream + PUBLISH ──► Redis
                                                                               │ pattern subscription
                         every API instance ◄──────────────────────────────────┘
                              │ SSE, per organization; event id = stream id
                           browsers ── reconnect with Last-Event-ID ──► replay what was missed (or "resync")
```

Events from the API *and* the worker reach every browser of that organization, whichever API
instance it is connected to; a dropped connection or an API restart doesn't leave a dashboard stale.

## AI, used carefully

Two features, one rule: **AI suggests, people decide, and every claim must point at evidence the
system can check.** Both run as worker jobs, redact credentials, emails and IPs before anything
leaves, use `claude-opus-5-5` with a server-side refusal fallback — and both have a deterministic
offline implementation (labelled as such, never as AI), so everything works without an API key.

**AI Incident Investigator** — *during* the incident. Connects alerts, deployments, log patterns
(fingerprinted, compared with a baseline) and service dependencies:

- **An agent where one earns it**: Claude chooses which evidence to pull through read-only tools —
  `list_alerts`, `list_deployments`, `search_logs`, `get_service_dependencies`,
  `list_related_incidents`, `get_incident_timeline` — bounded to 10 turns and 16 tool calls, and ends
  with a `submit_findings` call whose schema is enforced (`strict: true`).
- **Citations checked against a ledger**: the evidence store records every item its tools returned;
  findings may only cite those ids (`deploy:12`, `log:9811`, `alert:alert_01J…`). Invented citations
  are removed with a warning; an unsupported hypothesis drops to low confidence.
- **Tenant isolation in the tools**, not the prompt; tool output treated as data, never instructions.
- **Ranked hypotheses** with evidence for *and against*, next checks, a reconstructed timeline and
  open questions. *Post to timeline* turns one into the responder's note, marked unconfirmed.

**AI-assisted postmortem drafts** — *after* the incident. The model gets the incident, alerts,
responder notes and timeline (redacted, capped, every event with its id) and returns a
schema-validated suggestion where every statement cites timeline events; hallucinated citations are
stripped and flagged. The reviewer picks sections to apply; the root cause arrives as an
`[Unconfirmed AI hypothesis …]`; publishing requires an explicit review. **AI-generated postmortems
are treated as drafts; source timeline data remains authoritative.**

Details: [docs/architecture.md › AI incident investigator](docs/architecture.md#ai-incident-investigator)
and [› AI-assisted postmortem drafts](docs/architecture.md#ai-assisted-postmortem-drafts).

## Database design

```mermaid
erDiagram
  organizations ||--o{ organization_members : has
  users ||--o{ organization_members : "belongs to"
  organizations ||--o{ teams : has
  organizations ||--o{ escalation_policies : has
  escalation_policies ||--o{ escalation_steps : "ordered steps"
  escalation_steps ||--o{ escalation_step_targets : "users / teams"
  organizations ||--o{ services : has
  services ||--o{ service_dependencies : "depends on"
  services ||--o{ api_keys : "hashed keys"
  services ||--o{ alert_rules : "ordered rules"
  services ||--o{ alerts : receives
  services ||--o{ deployments : "changes"
  services ||--o{ log_events : "log lines"
  services ||--o{ incidents : affects
  incidents ||--o{ incident_alerts : groups
  alerts ||--o{ incident_alerts : "grouped into"
  incidents ||--o{ incident_responders : has
  incidents ||--o{ timeline_events : "append-only, hash-chained"
  incidents ||--o{ notifications : pages
  incidents ||--o| postmortems : has
  incidents ||--o{ postmortem_ai_drafts : "AI suggestions"
  incidents ||--o{ incident_investigations : "findings + evidence ledger"
  organizations ||--o{ webhook_endpoints : has
  webhook_endpoints ||--o{ webhook_deliveries : "outbox rows"
  organizations ||--o{ audit_log : records
```

Plain SQL migrations with comments on every table, in
[`packages/database/migrations`](packages/database/migrations). Constraints carry the rules that must
never break: one open incident per dedup key, one commander per incident, valid status transitions,
append-only timeline, one AI draft / investigation in flight per incident, same-tenant references.

## Security

Fireline holds credentials every monitored service uses and makes outbound calls from inside the
network, so it gets a real [threat model](docs/threat-model.md): assets, actors, trust boundaries,
STRIDE per element with the mitigating code and the test that proves it, and accepted residual risks.

| Control | |
| --- | --- |
| API key hashing | SHA-256, shown once, rotation with grace period, revocation, last-used |
| Rate limiting | Per-key token bucket (atomic Lua in Redis), bad-key IP lock-out, login throttling per account and IP |
| RBAC | `admin` / `responder` org roles; commander / responder / read-only observer per incident |
| Secure cookies | httpOnly, `SameSite=Strict`, `Secure` + HSTS behind HTTPS; HS256-pinned JWTs with issuer/audience |
| CSRF protection | Origin check on every cookie-authenticated write and on login; JSON-only bodies |
| Input validation | zod for every body, validated query params, body limits (`413`) |
| SQL injection | Parameterized queries only; hostile-input tests |
| Organization isolation | Every query tenant-scoped, foreign ids are `404`; 36 routes tested with another tenant's ids |
| Audit logs | Every change in the same transaction, sign-ins included; append-only hash-chained timeline |
| Webhook signatures | HMAC-SHA256 with timestamp (replay window); constant-time verifier in the SDK |
| SSRF | Webhook targets checked on the resolved address (DNS-rebinding safe), no redirects |
| Secrets | Environment only; a real install refuses a weak `JWT_SECRET` |
| Supply chain | `npm audit` job, CodeQL `security-extended`, Dependabot, non-root containers |

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Failure handling

*What if Redis goes down? Postgres? Two acknowledgements at once? The worker crashes mid-send? The
same webhook arrives twice?* Each is answered, with the test that proves it, in
[docs/failure-handling.md](docs/failure-handling.md). In short:

| What if… | |
| --- | --- |
| Redis goes down | Alerts still accepted in milliseconds (deadlines + fail-open); pages go out within 10 s of Redis returning; `/health` says `degraded` |
| PostgreSQL goes down | `503` + `Retry-After` within 5 s so senders retry; the API survives a database restart (it used to crash — no pool `error` listener) |
| Two alerts at once | One incident (partial unique index) |
| Two acknowledgements at once | One wins, one gets `409` (row lock + state machine) |
| Delivery fails | Exponential backoff, then the dead-letter queue |
| The worker crashes mid-job | Leases + sweeper: never two sends in parallel, never dropped, stable Message-IDs for the rare duplicate |
| The same webhook twice | `Idempotency-Key`: recorded once, the first response replayed |

## Running locally

**Everything in Docker** — only Docker needed:

```sh
git clone https://github.com/kgiannopoulou/incident-response-platform.git
cd incident-response-platform
cp .env.example .env
docker compose up -d            # web, api, worker, postgres, redis, mailpit; migrates + seeds on first start
npm run smoke                   # optional (needs Node): alert → incident → email page → ack → resolve
```

```
┌───────────────────────────┐
│ web      Next.js   :3000  │   http://localhost:3000   alex@acme.test / password123 (admin)
│ api      Express   :4000  │   http://localhost:4000/health
│ worker   BullMQ           │
│ postgres 16        :5435  │
│ redis    7         :6380  │
│ mailpit  SMTP/UI   :8025  │   http://localhost:8025   every page the worker sends
└───────────────────────────┘
```

`sam@acme.test`, `jordan@acme.test` and `riley@acme.test` are responders (same password; local demo
accounts only). Containers have healthchecks, run as non-root behind tini and shut down gracefully.
`docker compose run --rm migrate` re-applies migrations; with Node installed, `npm run db:migrate` and
`npm run db:seed` (wipes the demo data) work against the same database.

**Development with hot reload** (Node.js 20+):

```sh
cp .env.example .env            # then set JWT_SECRET to a long random string
npm run infra:up                # Postgres, Redis, Mailpit only
npm install
npm run db:migrate
npm run db:seed
npm run dev:api                 # three terminals
npm run dev:worker
npm run dev:web
```

Set `ANTHROPIC_API_KEY` in `.env` to have Claude write postmortem drafts and run the investigator
(`AI_POSTMORTEM_MODEL` / `INVESTIGATOR_MODEL`, default `claude-opus-5-5`); without it both use their
offline implementations.

### Simulate a production incident

Click **▶ Simulate production incident** on the dashboard (as Alex), or:

```sh
npm run demo:incident                         # deploys, logs and alerts of a checkout outage (~15 s)
npm run demo:incident -- --speed 5 --respond  # …and play the responders through to the postmortem
```

```
  -  26 h  DEPLOY    checkout-api      v2.13.4 — Retry card authorisation once on gateway timeout
  -50 min  DEPLOY    auth-service      v5.2.1 — Rotate session signing keys
  - 6 min  DEPLOY    checkout-api      v2.14.0 — Raise checkout worker concurrency 8 → 32 per pod

00:00  WARNING   checkout-api       CPU > 85% on checkout-7f9c                recorded
00:03  WARNING   checkout-api       Checkout p99 latency 1800ms               INC-64 opened (SEV3)
00:05  HIGH      checkout-api       Checkout error rate exceeded threshold    INC-65 opened (SEV2)
00:08  CRITICAL  checkout-api       Checkout error rate exceeded threshold    grouped into INC-65 (SEV1, 2 alerts)
00:12  CRITICAL  postgres-primary   Connection pool exhausted (500/500)       INC-66 opened (SEV1)
00:15  CRITICAL  checkout-api       Checkout error rate exceeded threshold    grouped into INC-65 (SEV1, 3 alerts)

— responders (Sam Rivera) —
00:18  Sam       acknowledges INC-65                                          ok
00:21  Sam       starts investigating                                         ok
00:22  Sam       runs the incident investigator                               ok
 …
00:44  Sam       asks for an AI postmortem draft                              draft requested → …/incidents/65/postmortem
```

Watch the Payments team get paged in Mailpit, leave the SEV1 unacknowledged to see the
acknowledgement timeout page the team lead early, and open INC-65's investigation.

From an application, with the SDK:

```ts
import { IncidentClient } from "@incident-platform/sdk";

const incidents = new IncidentClient({ apiKey: process.env.INCIDENT_API_KEY! });

await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db-connection" });
await incidents.deployment({ version: "v2.14.0", description: "Raise worker concurrency" }); // from CI/CD
```

## API documentation

The full reference is [docs/api.md](docs/api.md): alerts, auth, incidents and their actions,
services and API keys, dependencies, deployments and logs, investigations, postmortems and AI
drafts, escalation policies, webhooks, metrics, the simulator, the SSE stream, background jobs and
health. Machine endpoints authenticate with `Authorization: Bearer ir_live_…`; everything else with
the session cookie (or a Bearer session token for scripts).

## Testing

**356 tests**, most of them integration tests against a real Postgres and Redis (no mocks for the
database) — strategy, coverage and what they found in [docs/testing.md](docs/testing.md).

```sh
npm test                    # everything (needs the docker compose Postgres + Redis)
npm run test:unit           # shared logic, SDK, simulator — no services
npm run test:integration    # API + worker
npm run test:coverage
npm run lint && npm run typecheck
npm run smoke               # end to end against a running stack
```

| Business rule | How it's tested |
| --- | --- |
| `triggered → acknowledged ✓` · `acknowledged → investigating ✓` · `investigating → resolved ✓` · `resolved → investigating ✗` | The table over HTTP (409, row unchanged), all 20 pairs, the API table vs the database trigger on all 25, 2,000 random walks |
| 100 alerts with the same key → **1 incident, 100 attached alerts** | Sequentially *and* all 100 at once (one `incident_created`, 99 `grouped`, one page) |
| Notification attempt 1 → failure, 2 → failure, **3 → success** | Real BullMQ workers with production job options; all-fail → dead-lettered once |
| **Org A cannot read Org B incidents** | 36 id-addressed routes called by Org B's admin with Org A's ids → all `404`; lists clean; the investigator's tools return nothing across tenants |

Also: outages (the app built against a Redis and a Postgres that are down; backends killed
mid-flight), idempotency under concurrency, delivery leases, CSRF / brute force / forged JWTs / SQL
injection, SSRF via DNS, the investigator's correlation engine, its agent loop against a scripted
model (requests, tool results, citation checks, failure modes), AI-draft redaction and review gate,
realtime replay, the SDK end to end over HTTP. Writing the tests found a deadlock, a crash on
database restart, two `500`s that should have been `400`/`413`, and an inconsistent tenant check —
all fixed.

## CI/CD

```
Push / Pull Request
        │
        ├── ESLint ──────────── Node workspaces + Next.js rules
        ├── TypeScript check ── every workspace
        ├── Unit tests ──────── with coverage
        ├── Integration tests ─ API + worker against Postgres 16 + Redis 7 service containers
        ├── Build ───────────── Next.js production build; SDK compiled, packed, smoke-imported
        ├── Docker ──────────── all images, `docker compose up --wait`, end-to-end smoke test
        └── Audit ───────────── no high/critical advisories in production dependencies
```

Plus CodeQL and Dependabot. **Delivery**: a version tag (`v1.0.0`) re-runs CI, publishes the `api`,
`worker` and `web` images to `ghcr.io/kgiannopoulou/fireline-*` and creates a GitHub release with
the packed SDK; `docker compose -f docker-compose.yml -f deploy/docker-compose.images.yml up -d
--no-build` runs a release without building.

## Engineering decisions

The longer versions, with trade-offs, are in [docs/architecture.md](docs/architecture.md).

**Why PostgreSQL?** Incidents are strongly relational (organizations → services → alerts →
incidents → responders → timeline) and the hard parts are transactional: "open an incident unless
one is already open for this key", "acknowledge unless someone just did", "page level 2 exactly once".
Postgres settles those with unique indexes, row locks and triggers, so correctness doesn't depend on
every code path remembering a rule — and it is the single source of truth everything else can be
rebuilt from.

**Why Redis?** Ephemeral, fast-changing state: BullMQ queues and delayed escalation jobs, the SSE
fan-out between API instances, per-key token buckets. Nothing in Redis is the only copy of anything
that matters — notification rows, escalation deadlines and AI requests live in Postgres — so a Redis
outage degrades the platform (pages a few seconds late, no live updates) instead of losing data.

**Why SSE rather than WebSockets?** Almost all real-time traffic is server → browser. SSE is plain
HTTP: cookie authentication, proxies and reconnects come for free, and `Last-Event-ID` gave replay
almost for free too. Actions go through the normal REST API, where validation, authorization and
audit already live.

**Why append-only timeline events?** The timeline is the incident's record: what the postmortem,
the metrics and the AI features are built from, and what someone reaches for when asking "who did
what, when?". So it is never edited — no update path in the code, Postgres triggers refuse `UPDATE`
and `DELETE`, and a hash chain makes changes behind the application's back detectable. Corrections
are new events.

**Why separate workers?** Email, webhooks and model calls are slow and fail in ways the platform
doesn't control. If they ran inside the ingestion request, a slow SMTP server or a dead webhook
receiver would make alerts slow or lost exactly when they matter. The API commits and returns; the
worker retries with backoff, dead-letters what can't be delivered, and scales independently.

**Why side effects only after COMMIT?** Domain code records events and jobs on an `Effects`
collector that is flushed after the transaction commits, so nobody is paged for an incident that
rolled back; the opposite gap (committed, then crashed before enqueueing) is closed by the sweeper.

**Why a fast hash for API keys?** They are 192-bit random secrets, not passwords: there's nothing for
bcrypt to protect against, and a deterministic SHA-256 allows an indexed lookup on every request.

**Why an agent for investigation but not for postmortems?** Drafting a postmortem has a known input
— the whole incident — so one structured call is simpler and cheaper. Investigating doesn't: which
deployment, which log pattern, which dependency matters depends on what the evidence shows, so the
model chooses its next query. Both are bounded, read-only and validated against the evidence they
were given.

## Roadmap

- An eval set for the drafter and investigator (resolved incidents with known root causes: is the
  right hypothesis ranked first? any invented facts?) before changing prompts, tools or models
- More investigator evidence: traces, metrics queries, feature-flag changes, provider status pages
- On-call schedules (rotations) as escalation targets; SMS / push / Slack channels and preferences
- Server-side session revocation, SSO and MFA; scoped API keys (trigger-only vs. resolve)
- A customer-facing status page driven by service status
