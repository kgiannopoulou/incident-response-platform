# Contributing to Fireline

Thanks for taking a look. Fireline is a personal portfolio project, but issues and pull requests are
welcome. Bugs and feature ideas are tracked in [GitHub Issues](https://github.com/kgiannopoulou/incident-response-platform/issues).

## Development setup

Requirements: Docker (Compose v2) and Node.js 20+.

```sh
git clone https://github.com/kgiannopoulou/incident-response-platform.git
cd incident-response-platform
cp .env.example .env
docker compose up -d postgres redis mailpit   # backing services only
npm ci
npm run db:migrate && npm run db:seed
npm run dev                                   # api, worker and web with hot reload
```

Or run everything in containers with `docker compose up -d` (see the README).

## Tests and checks

```sh
npm run lint && npm run typecheck
npm run test:unit           # shared logic, SDK, simulator — no services needed
npm run test:integration    # API + worker against the compose Postgres and Redis
npm run smoke               # end to end against a running stack
```

Integration tests use a real database on purpose — please don't replace them with mocks. A change to
business rules (state machine, deduplication, escalation, tenancy) needs a test that proves the rule,
ideally under concurrency as the existing ones do.

## Making a change

1. Open or pick an issue, and comment with the approach for anything non-trivial.
2. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`, `test/<short-name>` or `docs/<short-name>`.
3. Database changes go in a new migration — never edit an applied one. The timeline is append-only:
   corrections are new events.
4. Side effects (jobs, notifications, SSE) are recorded on the `Effects` collector and flushed after
   commit; don't enqueue inside a transaction.
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   `feat: add maintenance-window suppression`, `fix: keep incident numbers gapless under races`.
6. Open a pull request with what changed, why, and how it was tested. CI (lint, typecheck, unit,
   integration, build, audit, CodeQL, Docker) must pass.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
