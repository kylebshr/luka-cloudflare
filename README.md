# luka-cloudflare

The Live Activity backend for Luka, on Cloudflare Workers. The iOS app registers its Live
Activities here. The backend polls Dexcom Share once per user and pushes each new reading
(or a "stale" update when none arrives) to every device through APNs. It ends activities
at their 7-hour limit and restarts them via push-to-start. It replaces a Vapor server and
keeps its API for the iOS app: the same routes, request bodies, and success/status
contract. Error bodies are this service's own.

## Prerequisites

- Node 22 (`nvm use`, which reads `.nvmrc`)
- `npm install`, then `npx wrangler types` to generate `worker-configuration.d.ts`.
  Wrangler is a dev dependency; run it with `npx wrangler`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run locally |
| `npm test` | Run the tests, in the Workers runtime |
| `npm run typecheck` | Typecheck |
| `npm run lint` | Check lint and formatting (Biome), as CI does |
| `npm run format` | Apply formatting and safe lint fixes |
| `npm run types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run deploy` | Deploy production |
| `npm run deploy:staging` | Deploy staging |
| `npm run tail` | Stream production logs (`npx wrangler tail --env staging` for staging) |

## Secrets

All optional; without them APNs is a no-op.

| Secret | Purpose |
|---|---|
| `PUSH_NOTIFICATION_PEM` | APNs `.p8` key contents |
| `PUSH_NOTIFICATION_ID` | APNs key ID |
| `TEAM_IDENTIFIER` | Apple team ID |

Secrets are per environment: `npx wrangler secret put <NAME>` sets production's, and
`npx wrangler secret put <NAME> --env staging` sets staging's. Locally, copy
`.dev.vars.example` to `.dev.vars` and fill them in.

## Deploying

- Merges to `main` deploy production through GitHub Actions (`.github/workflows/ci.yml`),
  after lint, typecheck, and tests pass. Pull requests run the checks only.
- Staging (`luka-staging`, a separate Worker with its own Durable Objects) is deployed by
  hand: run the CI workflow from the Actions tab (it deploys the chosen branch), or
  `npm run deploy:staging` locally.
- The workflow needs two repository secrets: `CLOUDFLARE_ACCOUNT_ID`, and
  `CLOUDFLARE_API_TOKEN`, an API token created from the **Edit Cloudflare Workers**
  template (its Account › Workers Scripts › Edit permission covers uploading the Worker
  and its Durable Object migrations).

## Observability

Every event is a structured log line (see the Telemetry section of the architecture doc).
Logs and traces are in the Cloudflare dashboard under Workers Observability, and
`npx wrangler tail` streams them live. To export them over OpenTelemetry, create an OTLP
destination in the dashboard and add its name to `observability.logs.destinations` and/or
`observability.traces.destinations` in `wrangler.jsonc`.

## Design

See [docs/architecture.md](docs/architecture.md).
