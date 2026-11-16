# Threat model: syn.horse + syn-horse-notifications

Status: written from the code (2026-11-16) and updated with the owner's answers the same day; facts the owner gave are marked **(user-stated)**.

## System overview and trust boundaries

A one-person personal site and its paging pipeline, both on Cloudflare Workers.

```text
internet visitor ──HTTPS──> syn.horse Worker (Nuxt 4 / Nitro, cloudflare_module)
                              │    hosts: syn.horse, www.syn.horse, syn-horse.synmux.workers.dev
                              │  POST /api/panic (Turnstile) ──> 1. Queue "syn-horse-notifications"
                              │                               └─> 2. D1 DB (panic_pages row)
                              └─ SSR blog from D1 DB_CONTENT (self-healing sync), KV
Queue ──> syn-horse-notifications Worker (queue consumer)
            log (D1) → rate limit (KV) → AI moderation (TypeSafe Jev API) → delivery
            delivery: green → ntfy.sh topic "syn-horse", red → Pushover (owner's phone)
ntfy "ack" button ──HTTPS──> notifications Worker GET/POST /ack (X-Self-Token)
```

Trust boundaries:

1. Internet → syn.horse Worker (all public routes, `/api/panic`). Every route is reachable on each of its hostnames: the `syn.horse` and `www.syn.horse` custom domains and `syn-horse.synmux.workers.dev` (`workers_dev: true` in the `nitro.cloudflare.wrangler` block of `nuxt.config.ts`).
2. syn.horse Worker → Queue → notifications Worker. Queue messages are producer-built but carry visitor-controlled `channel`, `message`, `contact`, and a `source` taken from `X-Forwarded-For` / `CF-Connecting-IP` (`server/utils/pager.ts`). `channel` is the visitor's choice of `red` or `green` and selects delivery: `red` → Pushover at maximum priority, `green` → ntfy.
3. Notifications Worker → third parties: TypeSafe (moderation), ntfy.sh, Pushover, Cloudflare Email.
4. Internet → notifications Worker `/ack` on `syn-horse-notifications.synmux.workers.dev` (`workers_dev: true`).
5. Build/CI: GitHub Actions (`.github/workflows/*`, Claude review actions), npm deps via pnpm (`minimumReleaseAge` one week in notifications).

Trusted (assumed): the owner, the Cloudflare account, GitHub org `synmux`, Cloudflare platform itself.

## Components

| Component           | Code                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site frontend       | `syn-horse`: `app/**` (pages, layouts, components, `app/data/*.ts`), `content/blog/*.md`, `public/`                                                                                                                                                    |
| Site server         | `syn-horse`: `server/api/**`, `server/utils/**`, `server/middleware/**`, `server/db/**`, `modules/**`, `nuxt.config.ts` (routeRules, nuxt-security CSP, Turnstile)                                                                                     |
| Paging consumer     | `syn-horse-notifications`: `src/index.ts`, `src/schema.ts`, `src/stages/**`, `src/db.ts`, `src/kv.ts`, `src/jev.ts`, `migrations/**`                                                                                                                   |
| Delivery adapters   | `syn-horse-notifications`: `src/adapters/**` (ntfy, pushover, email, twilio, stub)                                                                                                                                                                     |
| Ack endpoint        | `syn-horse-notifications`: `src/http.ts`                                                                                                                                                                                                               |
| Infrastructure & CI | `syn-horse`: `nitro.cloudflare.wrangler` block in `nuxt.config.ts`, `wrangler.dev.jsonc`, `.github/**`, `lefthook.yml`, `.trunk/**`; `syn-horse-notifications`: `wrangler.jsonc`, `.github/**`; both: `package.json`, `pnpm-workspace.yaml`, lockfiles |

## Entry points and who can reach them

- **Public site pages** (`app/pages/**`, blog `[slug]`): anyone, on `syn.horse`, `www.syn.horse` and `syn-horse.synmux.workers.dev`. Server-rendered; blog content from the owner's own markdown.
- **`POST /api/panic`** (`server/api/panic.post.ts`): anyone who passes Cloudflare Turnstile. Zod-validated (`channel` `red`/`green`, `message` 10–2000, `contact` 3–200). In dev (`import.meta.dev`) Turnstile is skipped. Enqueues the page first, then inserts the `panic_pages` row with status `queued` or `send_failed`. If the insert fails after a successful send, the page is delivered with no D1 record and the request errors; a retry gets a fresh UUID and enqueues a duplicate page.
- **Content-sync middleware** (`server/middleware/content-sync.ts`): runs on content queries; rebuilds D1 `DB_CONTENT` from the bundled dump; can send red/green pages on failure/recovery.
- **Easter-egg redirects** (`/sudo`, `/ssh`, `/gpg` → `public.syn.horse`): anyone.
- **Queue consumer**: only the syn.horse Worker produces (no producers configured in notifications `wrangler.jsonc`).
- **`/ack`** (`src/http.ts`): anyone on the internet; requires `X-Self-Token == SELF_TOKEN`; wildcard CORS; currently does nothing beyond echoing the message id.

## Assets and sensitivity

**(user-stated)** The owner named **Worker secrets** and **site integrity** as the assets that matter most (critical). The paging channel, visitor PII and Cloudflare cost stay in scope at normal weight.

- **Paging channel integrity/availability** – the owner's phone gets Pushover (red, max priority) and ntfy (green) pages. Abuse = harassment / alert fatigue; suppression = missed real incidents.
- **Worker secrets** – `NTFY_TOKEN`, `SELF_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_TOKEN`, `TYPESAFE_API_KEY`, Turnstile secret. Note: `SELF_TOKEN` is placed in the ntfy action headers (`src/adapters/ntfy.ts`) and so is visible to anyone who can read the ntfy topic.
- **Visitor PII** – `contact` and `message` from the panic form, stored in syn-horse D1 `panic_pages`, notifications D1 log table, Worker logs (`console.info` logs full payloads), and sent to TypeSafe (message only), ntfy and Pushover.
- **Site integrity** – content and scripts served on syn.horse (XSS, defacement, CSP, SRI).
- **Cloudflare resources/cost** – D1, KV, Queue, TypeSafe API quota.

## Attacker profiles

**(user-stated)** Every attacker matters; nothing is ruled out. The owner specifically called out anonymous visitors/bots, spammers or abusers targeting `/api/panic` to page him, and supply chain (npm, GitHub Actions).

1. **Anonymous internet visitor / bot** – can hit every public route, solve or farm Turnstile, set arbitrary request headers (incl. `X-Forwarded-For`).
2. **Targeted pager abuser** – wants to flood, spoof, or suppress pages to the owner (e.g. rotate the `source` value to dodge per-source rate limits; prompt-inject the moderation model).
3. **ntfy topic reader** – anyone able to subscribe to the `syn-horse` topic on public ntfy.sh (depends on whether the topic is reserved/access-controlled; unknown from code).
4. **Supply chain** – compromised npm package or GitHub Action (actions are SHA-pinned in notifications).

Out of model (assumed trusted): the owner, Cloudflare account holders, GitHub org admins.

## Existing controls

- Turnstile on `/api/panic` in production; Zod validation on both producer and consumer (`z.strictObject` on the consumer).
- Per-source KV rate limits (hour 10 / day 100 / lifetime 1000) – fail open on KV errors by design.
- AI moderation (Jev) – shadow mode by default (`MODERATION_ENFORCE="false"`), fails open by design.
- nuxt-security headers + CSP (nonce, `strict-dynamic`, `wasm-unsafe-eval`), SRI. The `security.ssg` `hashScripts`/`hashStyles` options only hash prerendered pages, so SSR responses rely on the nonce CSP, not on hashes.
- Secrets supplied via `wrangler secret`, not committed; `preview_urls: false`.
- CI: DevSkim, Claude review, SHA-pinned actions, pnpm `minimumReleaseAge`.

## Out of scope / accepted risk

**(user-stated)** Accepted risk / out of scope:

- Dev-only paths: the `import.meta.dev` Turnstile bypass in `server/api/panic.post.ts` and the tailnet dev host in `wrangler.dev.jsonc` / the wrangler dev block. Findings that only matter in local dev are out of scope.
- AI moderation running in shadow mode (`MODERATION_ENFORCE="false"`) and failing open (`src/stages/ai.ts`, `src/jev.ts`).
- Rate limiter failing open on KV errors (`src/stages/rate-limits.ts`).

Still in scope (not ruled out): the `/ack` endpoint, rate-limit _bypass_ (e.g. spoofing `source`), and anything else not listed above.

## Open questions

- Is the ntfy topic `syn-horse` reserved/access-controlled on ntfy.sh? (Decides who can read `SELF_TOKEN` from the ack action headers.)
