# Changelog

All notable changes to Fireline are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Planned as **1.1.0**.

### Added
- OpenAPI 3.1 specification (`docs/openapi.json`).
- Alert-storm load test (`npm run loadtest`) with latency percentiles, and live ingestion
  throughput/latency on the System page (`GET /api/v1/admin/ingestion`).
- README: production considerations, 100× scale notes and honest limitations.
- MIT licence, `CONTRIBUTING.md` and this changelog.

### Fixed
- Incident numbers stay gapless when two requests race for the same deduplication key
  (found by the first load-test run).
- The web app's System page contained stray Windows-1252 bytes, which broke `next build`
  under Turbopack; the file is now valid UTF-8.

## [1.0.0] - 2026-10-16

First complete release: phases 1–25 plus the AI Incident Investigator.

### Added
- Alert ingestion API with hashed per-service API keys, deduplication keys, `Idempotency-Key` and rate limits.
- Correlation of alerts into incidents; state machine enforced in the API and a PostgreSQL trigger.
- Immutable, hash-chained incident timeline; real-time updates over SSE with replay.
- Responder roles (Incident Commander, responder, observer), escalation policies, acknowledgement timeouts.
- Email pages and HMAC-signed webhooks with retries, a dead-letter queue and an SSRF guard.
- Postmortems built from the timeline; AI-assisted drafts with checked citations and a review gate.
- AI Incident Investigator: a bounded Claude agent over read-only tools, with an offline rules fallback.
- MTTA/MTTR dashboard, production-incident simulator and the `@incident-platform/sdk` package.
- Failure handling for Redis/PostgreSQL outages, delivery leases and idempotent ingestion.
- One-command `docker compose up`; CI/CD with tagged image releases to GHCR.
- Security hardening (CSRF, login throttling, hardened sessions, DNS-rebinding-safe SSRF guard) and a STRIDE threat model.

### Fixed
- A deadlock under alert bursts (found by the business-rule tests).

[Unreleased]: https://github.com/kgiannopoulou/incident-response-platform/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kgiannopoulou/incident-response-platform/releases/tag/v1.0.0
