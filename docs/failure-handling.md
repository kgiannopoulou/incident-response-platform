# Failure handling

An incident platform is needed most on the day other things are failing, so it has to keep
working when its *own* dependencies fail. This page goes through the questions the plan asks —
*what if Redis goes down? what if two responders acknowledge at once?* — and answers each with the
behaviour, the mechanism behind it and the test that proves it.

The short version: **PostgreSQL is the source of truth; Redis is an accelerator.** Anything that
must happen (a page, an escalation, a webhook, an AI draft) is a row in Postgres, written in the same
transaction as the change that caused it. Redis queues carry only ids, so losing them delays work by
seconds instead of losing it, and every job is idempotent so running it twice is harmless.

```
                 ┌──────────── one transaction ────────────┐
alert ─► API ──► │ alert + incident + timeline + audit +    │ ─► COMMIT ─► enqueue job ids (best effort,
                 │ notification / webhook rows ('queued') + │              2 s deadline, skipped while
                 │ next_escalation_at / ack_deadline_at     │              Redis is known to be down)
                 └──────────────────────────────────────────┘
                                        ▲
              worker sweeper, every 10 s: re-drives anything due or still 'queued' from Postgres
```

## The questions

| What if… | What happens | How | Test |
| --- | --- | --- | --- |
| **Redis goes down?** | Alerts are still accepted (`202`, ~20 ms in a manual drill — as fast as usual), incidents open, responders can acknowledge and resolve. Pages go out when Redis is back, within one sweep (10 s). Live browser updates pause; dashboards resync on reconnect. `/health` says `degraded` (still `200`). | Request-path Redis calls have deadlines (rate limiter 1 s, post-commit flush 2 s) and are skipped at once while ioredis reports the connection lost (`redisIsDown`). The rate limiter fails open. Escalations are driven by `incidents.next_escalation_at`, pages by `notifications` rows. | `apps/api/test/failure-handling.test.ts` › *What if Redis goes down?* |
| **PostgreSQL goes down?** | Alert senders get `503` + `Retry-After: 5` within 5 s (never a hang, never a `500`), so monitoring tools and the SDK retry. `/health` → `503` (`acceptingAlerts: false`), `/health/live` stays `200` so orchestrators don't restart a process a restart can't fix. The worker's jobs fail and back off; rows still `queued` are re-driven by the sweeper when the database is back. | `connectionTimeoutMillis: 5000` on the pool; `isDatabaseUnavailable()` maps connection errors (`ECONNREFUSED`, `57P01`, `08006`, "Connection terminated", …) to `503`. | *What if PostgreSQL goes down?* |
| **PostgreSQL restarts / fails over?** | The API and worker keep running and the next request succeeds on a fresh connection. **Before Phase 21 this crashed the process:** idle pooled clients emit `error` when the server kills their connection, and `pg.Pool` had no listener, which Node treats as an uncaught exception. | `pool.on("error")` logs and lets the pool discard the client; `withTransaction` destroys (not re-pools) a client whose `ROLLBACK` failed. | *survives Postgres killing its connections* (terminates the pool's backends with `pg_terminate_backend`) |
| **Two alerts arrive simultaneously?** | One incident. With 100 identical alerts in flight at once: 1 `incident_created`, 99 `grouped`, one page. | Partial unique index: one *open* incident per `(service, dedup_key)`; `INSERT … ON CONFLICT DO NOTHING`, the loser joins the winner. Service row locked `FOR NO KEY UPDATE` (a `FOR UPDATE` deadlocked under bursts — found by the 100-alert test). | `business-rules.test.ts`, `correlation.test.ts` |
| **Two responders acknowledge simultaneously?** | One wins (`200`), the other gets `409` with the current state; one `INCIDENT_ACKNOWLEDGED` event, one webhook, escalation stopped once. | `changeStatus()` row-locks the incident (`SELECT … FOR UPDATE`) and re-checks the state machine inside the lock; a Postgres trigger enforces the same transitions. | `incidents.test.ts`, `business-rules.test.ts` |
| **Notification delivery fails?** | Retried with exponential backoff (pages 2 → 16 s, webhooks 5 → 40 s), then marked `failed` and copied to the dead-letter queue, where an admin can retry or discard it. A `410 Gone` webhook disables the endpoint. | Per-queue `RETRY_POLICY`; `handleFailures` → dead-letter queue; failure details on the row. | `retries.test.ts` (fail, fail, succeed), `webhooks.test.ts` |
| **The worker crashes halfway through processing?** | Nothing is lost and nothing is sent twice *in parallel*. A job interrupted by a crash is re-delivered (BullMQ stalled-job check) or re-driven by the sweeper. A page that may already have left before the crash is re-sent once — at-least-once — with the same `Message-ID` / `Fireline-Delivery` id so it can be recognised as a duplicate. | **Delivery leases**: before calling SMTP or a webhook URL, the worker sets `delivering_until = now() + 60 s` with a conditional `UPDATE`. A second worker skips a leased row; an expired lease means the owner died, and the sweeper re-drives it. Escalation steps re-read and row-lock the incident, so a re-run pages nobody twice. | `apps/worker/test/failure-handling.test.ts` |
| **The same webhook (alert) arrives twice?** | With an `Idempotency-Key` header, it's recorded once: the repeat gets the first response replayed (`Idempotent-Replayed: true`, `"replayed": true`). Ten concurrent copies → one alert. The same key with a different body → `422`. Without a key, the repeat is a second alert grouped into the same incident (the alert count goes up, nobody is paged again). | `alert_idempotency_keys (service_id, key)` primary key, claimed with `INSERT … ON CONFLICT DO NOTHING` *inside* the alert's transaction and holding the stored response, so key and alert commit (or roll back) together. Concurrent duplicates wait on the unique index. Keys expire after 24 h. | *What if the same webhook (alert) arrives twice?* |
| **The response to a sender is lost?** | The SDK retries and gets the original answer back instead of creating a second alert. | The SDK sends one `Idempotency-Key` per `alert()` call (a random UUID, or yours) and reuses it on every retry of that call. | *SDK retries* (a fetch that commits and then "drops the connection") |
| **A queue job is lost (Redis flushed, crash between COMMIT and enqueue)?** | Recovered within one sweep. | Sweeper re-enqueues `queued` rows older than 30 s (not under a live lease), runs due escalations and passed acknowledgement deadlines, fails AI drafts stuck in `generating`. Job ids are fixed per row, so a job that *does* still exist isn't duplicated. | `worker.test.ts`, `ack-timeout.test.ts` |
| **Two worker replicas run the sweeper at the same time?** | Harmless: every step is idempotent and row-locked. | `escalateIncident` locks and re-checks; leases and `status = 'queued'` guards on deliveries; ack timeouts fire once (job + sweeper racing is tested). | `ack-timeout.test.ts` |
| **The process is told to stop while a dependency is down?** | It still exits: graceful shutdown waits for in-flight work but every step has a deadline (API 10 s, worker 25 s; compose gives the worker a 30 s grace period). | `closeRedis()` falls back to dropping the socket; forced exit timer. | — |

## Idempotency, step by step

```
POST /api/v1/alerts            Idempotency-Key: prom-evt-8812
  BEGIN
    DELETE key if older than 24 h
    INSERT INTO alert_idempotency_keys (service, key, sha256(body)) ON CONFLICT DO NOTHING
      ├─ inserted ─────────► process the alert as usual … UPDATE … SET response = <result>
      └─ conflict ─┬─ same body hash ─► return the stored response (nothing else written)
                   └─ other hash ─────► 422
  COMMIT
```

A concurrent duplicate blocks on the `INSERT` until the first transaction commits, then sees its
row; if the first transaction rolled back (invalid payload, database error), the key was never
stored and the retry is processed normally.

## Delivery guarantees

| | Guarantee | Duplicates | Receiver's part |
| --- | --- | --- | --- |
| Pages (email) | at-least-once | only if a worker dies between "sent" and recording it; same `Message-ID` | — |
| Webhooks | at-least-once | same, with the same `Fireline-Delivery` header and payload `id` | dedupe on `id` |
| Escalation steps | exactly-once per level | none (row lock + level check) | — |
| Timeline events | exactly-once | none (written in the transaction of the change) | — |

Exactly-once delivery to an external system isn't achievable without the receiver's help; the
platform's job is to never lose a page, never send two in parallel, and make the rare post-crash
duplicate identifiable.

## Trying it by hand

```sh
docker compose stop redis                         # Redis outage
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -X POST http://localhost:4000/api/v1/alerts \
  -H "Authorization: Bearer ir_live_dev_checkout_api" -H "Content-Type: application/json" \
  -d '{"severity":"critical","title":"Checkout down","deduplicationKey":"chaos"}'
# 202 0.04s — the incident is open; curl http://localhost:4000/health → "status": "degraded"
docker compose start redis                        # within ~10 s the worker sweeper pages the on-call

docker compose stop postgres                      # database outage → 503 + Retry-After: 5
docker compose start postgres                     # API and worker carry on without a restart
```
