# Security policy

Fireline is a portfolio project, but security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on this repository) with:

- what an attacker can do, and what they need (an account? an API key? network position?),
- steps or a proof of concept against a local `docker compose up` install,
- the commit you tested.

I'll acknowledge within a few days and credit you in the fix unless you'd rather not be named.

## Scope

The API, worker, web app, SDK, database migrations, Docker setup and CI workflows in this
repository. The threat model, controls and known residual risks are documented in
[docs/threat-model.md](docs/threat-model.md); issues already listed there as accepted risks are
still worth reporting if you see a practical exploit.

## Deploying it

- Set `DEMO_ENABLED=false` and a random `JWT_SECRET` of 32+ characters (the API refuses to start
  otherwise).
- Serve the web app and API over HTTPS behind a reverse proxy; set `COOKIE_SECURE=true` and
  `TRUST_PROXY`.
- Keep Postgres and Redis on a private network; don't publish their ports.
- Leave `WEBHOOK_BLOCK_PRIVATE_NETWORKS` on (the production default).
