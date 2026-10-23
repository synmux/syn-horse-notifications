# `syn-horse-notifications`

Cloudflare Worker queue consumer for processing notification messages through a staged pipeline (logging, rate limits, AI moderation, delivery).

## Current status

- Worker entrypoint is `src/index.ts`. It runs primarily as a **Queues consumer**, and also exposes a small `fetch` handler for a single `/ack` HTTP endpoint.
- All pipeline stages are active: **logging**, **rate limits**, **AI moderation**, and **delivery**.
- Delivery routes by paging channel: `green` → **ntfy**, `red` → **pushover**.

## Architecture

For each queue message:

1. Validate payload with Zod (`safeParseMessage` in `src/schema.ts`)
2. Insert an audit row in D1 (`runLogging`)
3. Enforce KV-based per-source rate limits (`runRateLimits`)
4. Run AI moderation through TypeSafe's Jev model (`runAi`)
5. Deliver via the channel's adapter and update the final result (`runDelivery`)

Any stage can short-circuit (`STOP`) — for example a rate-limit drop or an AI `spam`/`gibberish` verdict — in which case the message is ACKed and later stages are skipped.

AI moderation sends one request with three questions (what kind of message this is, whether it tries to manipulate the screening system, how urgent it is) and applies the drop thresholds in code (`src/stages/ai.ts`). It **fails open**: if Jev cannot be reached the page is delivered and the row is marked `ai_decision = 'error'`.

Error behavior:

- Invalid payloads are logged and ACKed (not retried).
- Runtime failures in logging or delivery throw and the queue message is retried. Rate-limit and AI failures never throw; both fail open.

### `/ack` HTTP endpoint

The `fetch` handler (`src/http.ts`) serves one route, `/ack`, used by the ntfy notification's "ack" action button. It requires `X-Message-Id` and `X-Self-Token` headers and checks the token against the `SELF_TOKEN` secret (`401` on mismatch, `400` if a header is missing, `404` for any other path).

## Data model

Inbound payload schema (`src/schema.ts`):

- `channel`: `"red" | "green"`
- `contact`: non-empty string (max 256)
- `message`: non-empty string (max 8192)
- `source`: optional IPv4/IPv6/hostname

D1 migrations (`migrations/`) create a `log` table that stores:

- raw message fields
- rate-limit decision/violation
- AI decision (`accept` / `drop` / `error`), kind, probabilities, urgency, model and reason
- adapter(s) used
- terminal result (`dropped` / `delivered` / `failed`)

## Adapters

The adapter interface is in `src/types.ts`; lookup is an explicit switch in `src/adapters/index.ts`. Delivery picks an adapter by channel (`green` → `ntfy`, `red` → `pushover`).

Available adapters:

- `ntfy` (active): publishes to ntfy.sh; `red` pages use max priority, and the notification carries an "ack" action button that calls `/ack`
- `pushover` (active): publishes via Pushover; `red` pages are emergency priority (siren, re-alerting until acknowledged), and bodies are truncated to 1024 characters
- `email` (placeholder): returns success without sending; will use the Cloudflare `EMAIL` binding
- `stub`: no-op success adapter (registered, but not part of the current channel routing)
- `twilio` (placeholder): present in `src/adapters/twilio.ts` but **not yet registered** in `getAdapter`

## Secrets and configuration

Configured in `wrangler.jsonc`:

- Secrets (`secrets.required`, set with `wrangler secret put`): `NTFY_TOKEN`, `SELF_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_TOKEN`, `TYPESAFE_API_KEY`
- Plain vars: `NTFY_SERVER` (default `https://ntfy.sh`), `NTFY_TOPIC`

## Prerequisites

- pnpm `12.4.1` (pinned in `package.json` `packageManager`; Corepack or mise will fetch it)
- Node `24.20.0`
- Wrangler `4.x`

Pinned versions are defined in `.node-version`, `.tool-versions`, and `mise.toml`.

## Setup

```bash
pnpm install
```

Then generate worker runtime types:

```bash
pnpm run types
```

## Development

Run local worker:

```bash
pnpm run dev
```

`pnpm run start` is equivalent.

## Database migrations

Apply D1 migrations remotely:

```bash
pnpm run db:migrate
```

Apply migrations locally:

```bash
pnpm run db:migrate:local
```

## Linting and formatting

Run full checks:

```bash
pnpm run lint
```

Useful subsets:

```bash
pnpm run lint:ultracite
pnpm run lint:types
```

Format all files:

```bash
pnpm run format
```

## Deployment

```bash
pnpm run deploy
```

## Notes and gotchas

- `worker-configuration.d.ts` is generated (`wrangler types`); avoid hand-editing.
- `postinstall` runs `wrangler types`; a plain `pnpm install` may rewrite `worker-configuration.d.ts`.
- Install policy is in `pnpm-workspace.yaml`: `allowBuilds` lists packages allowed to run install scripts (add new ones there or `pnpm add` fails), and `minimumReleaseAge` keeps resolved versions at least a week old.
- `pnpm test` runs the Vitest suite in `test/`; Jev responses are replayed from `test/fixtures/jev-moderation.json`, so no network or API key is needed.
- `.env.example` / `.dev.vars.example` are currently empty.

