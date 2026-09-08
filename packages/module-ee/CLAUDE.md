# @appstrate/cloud — Developer Guide

Private Cloud/SaaS billing module for Appstrate. Enabled by setting `MODULES=@appstrate/cloud` in the platform env. When absent from the env var (default), the platform runs in OSS mode.

> **Deploy lockstep — requires `@appstrate/core` ≥ 10.0.0.** (`peerDependencies` in `package.json` is the source of truth for that floor — the platform's gate reads that range, not this paragraph. Outside this paragraph the only place that restates the number is the operator hint in `src/billing/usage-quote.ts`; every other reference to the floor names it rather than versions it, so a bump touches `package.json`, this line and that hint.) This module bills off the platform's `llm_usage` cursor (`services.usage.list` / `usage.settledFrontier`) and gates admission via the unified `beforeUsage` hook (which replaces `beforeRun` and `runs.listLlmUsage`). Admission additionally reads the `credentialSource` / `executionPlane` / `timeoutSeconds` execution facts the platform reports on every dispatch. The cursor and the facts landed in core 5.0.0; the dependency now pins **10.0.0**, and four platform capabilities are consumed **unconditionally**: `PlatformServices.setFileStorageLimit` (storage-entitlement projection), `ModuleInitContext.getOrgName` (billing-email org labels), and the two org queries `getOrgOwnerEmails` / `getOrgMembers` that landed in 10.0.0 (billing contact + billing managers — see **Billing managers and billing contact** below). The structural capability probe and the optional-dep fallback that used to absorb their absence are gone — a platform that does not provide them now fails loudly instead of silently skipping the storage sync / dropping the org label. **Release order: ship the OSS release → cut this cloud version at the same tag.** There is no npm step for cloud any more: `@appstrate/core` is an **optional peer** declared as `>=10.0.0`, and the cloud image resolves it from the platform image it is built `FROM` (the Dockerfile symlinks `/app/node_modules/@appstrate/cloud/node_modules/@appstrate/core` → `/app/packages/core`). The contract is therefore **the image tag, plus the `>=10.0.0` floor enforced at boot** by the platform's core-version gate (`MODULE_CONTRACT_ENFORCE`, `apps/api/src/lib/modules/module-loader.ts`), which reads that peer range and refuses a platform below it. One consequence worth stating plainly: cloud can no longer be a version behind or ahead of the core it runs on, because there is only ever one copy of core in the image. An older platform lacks `services.usage`, so the sweeper would crash at its first tick. An older platform also sends no execution facts — that case is **guarded, not merely warned about**: `beforeUsage` detects absent or out-of-union `credentialSource` / `executionPlane`, logs at error level, and quotes the operation as the WORST case (platform credential + platform compute) instead of short-circuiting or quoting zero, so skew over-gates rather than handing out unmetered usage. The guard is a safety net, not a supported mode: it charges quota against operations the org may be funding itself. Verify the platform version — the symptom is an error-level `unusable execution facts` log, not a boot failure. **No rolling deploy of the cloud module itself:** migration 0001 drops columns/tables the OLD cloud code still writes (`cloud_usage_records.run_id`, the `cloud_pending_bills` table), so old and new cloud code must not run side by side against the same cloud DB — deploy cloud as a single instance (swap, don't overlap). Migration 0002 (`cost_usd` → `numeric`) is backward-compatible with the code that precedes it, so it carries no additional deploy constraint.

## Quick Start

```sh
bun install
ln -sfn ../../../appstrate/packages/core node_modules/@appstrate/core   # see below
bun run check         # tsc + eslint + prettier + verify:no-migration-dml
```

### Getting `@appstrate/core` into a cloud checkout

`@appstrate/core` is an **optional peer**, not a dependency: `bun install`
installs nothing for it, on purpose (an npm copy would be a second core, and the
image resolves the platform's). So a fresh checkout has no core, and `tsc` fails
with a wall of `TS2307 Cannot find module '@appstrate/core/…'` until you link
one. The link is also what the tests need — `src/logger.ts`,
`src/http-errors.ts`, `src/middleware.ts` and `src/routes/billing.ts` import
**values** from core, so `bun test` cannot run without it either.

Symlink the platform's workspace copy (assumes the standard side-by-side layout,
`…/appstrate/cloud` next to `…/appstrate/appstrate`):

```sh
ln -sfn ../../../appstrate/packages/core node_modules/@appstrate/core
```

Two traps, both verified against bun 1.3.11:

- **`bun link @appstrate/core` does not work here.** It prints `done` and
  creates nothing, because core is not a declared dependency. Worse,
  `bun link @appstrate/core --save` rewrites the peer range to
  `"@appstrate/core": "link:@appstrate/core"` — a `link:` prefix matches the
  platform's `IN_TREE_RANGE_PREFIXES` and **disables the core-version gate
  entirely**. Never commit that. (`bun link @appstrate/cloud` in the _other_
  direction is unaffected — see below.)
- `bun install` does **not** prune the manual symlink (checked with
  `bun install`, `bun install --force`, and a repair install). Only
  `rm -rf node_modules` takes it out; re-run the `ln -sfn` after that.

To make the platform load this module, link in the other direction — that one is
a normal `bun link` and still works:

```sh
bun link                                      # register @appstrate/cloud globally (once)
cd ../appstrate && bun link @appstrate/cloud  # symlink into platform node_modules
```

After each `bun install` in the appstrate repo, re-run `bun link @appstrate/cloud`.

### What CI runs

CI does **not** run `bun run check` as one command, because `tsc` needs core:

| Job                 | Where                                      | What                                                                        |
| ------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `resolve-oss-image` | runner                                     | picks the OSS image tag (see below)                                         |
| `lint`              | runner                                     | `bun run lint` + `bun run format:check` + `bun run verify:no-migration-dml` |
| `typecheck`         | inside `ghcr.io/appstrate/appstrate:<tag>` | `tsc --noEmit` against `/app/packages/core`                                 |
| `test`              | runner, `/app` extracted from that image   | `bun run test`                                                              |

The typecheck runs inside the OSS image so it compiles against the literal core
bytes the cloud image will ship — and against the image's own `typescript`, so
compiler skew is impossible too. `release.yml` calls `check.yml` with no input
as an early gate, then re-runs the typecheck against the **resolved tag** inside
`build-and-push`, before the push.

**There is no `ghcr.io/appstrate/appstrate:latest`** and there never has been:
the OSS release workflow's `docker/metadata-action` uses `flavor: latest=auto`,
which withholds `latest` from a semver prerelease, and every release so far is a
`1.0.0-beta.X`. So `resolve-oss-image` resolves the tag at run time from the OSS
repo's **GitHub Releases** (newest release whose tag matches `^v[0-9]`, `v`
stripped), then verifies the manifest actually exists in GHCR. `^v[0-9]` is not
cosmetic — the same repo publishes `core@X.Y.Z` / `afps-shared@X.Y.Z` /
`afps-schema@X.Y.Z` releases, none of which has a platform image. Every failure
path is fatal: nothing falls back to a tag that may not exist. Pass
`appstrate_version` to override.

Neither `check.yml` nor a local `docker pull` needs GHCR credentials — the OSS
package is public and pulls anonymously.

The `test` job extracts the image's **entire `/app`** into `.oss-image/`
(gitignored, 613 MB, ~17 s) with symlinks **preserved**, then points
`node_modules/@appstrate/core` at `.oss-image/app/packages/core`. Copying only
`packages/core` — even dereferenced — does not work: core's deps are symlinks
into bun's isolated store, and dereferencing them yields the package directories
without their own children (`.bun/pino@10.3.1/node_modules/` holds `pino` AND
`pino-std-serializers` as siblings). Keeping the symlinks means keeping the
store, and the links are relative (`../../../node_modules/.bun/…`), so the whole
`/app` shape has to survive.

> **Beware "it passed locally".** A `node_modules` that has ever had
> `@appstrate/core` installed from npm keeps core's hoisted transitive deps at
> the top level forever — `bun install` does not prune extraneous top-level
> directories. Those stale copies silently satisfy a half-materialised core, so
> a broken CI setup looks green on a developer machine. Reproduce CI failures
> with `rm -rf node_modules && bun install --frozen-lockfile`, not a plain
> `bun install`.

`hono` and `zod` are pinned to **exact** versions matching the platform
(`hono` 4.12.32, `zod` 4.4.3 as of `appstrate:1.0.0-beta.45`). This is not
tidiness: once core resolves from the platform, core's `hono` peer resolves next
to core while cloud's resolves in cloud, and `tsc` rejects the mix with
`TS2322 Type '() => Hono<CloudEnv…>' is not assignable to '() => Hono<any…>'`
(`preserveSymlinks` does not fix it). Bump these together with the OSS image.

## Architecture

Cloud implements the `AppstrateModule` contract from `@appstrate/core/module`. The platform loads it via dynamic import at boot through the module system (`apps/api/src/lib/modules/`). The module must be declared in `MODULES` env var — all declared modules are required (if declared but not installed, the platform crashes at boot with a clear error).

```
appstrate (OSS)                          cloud (this module)
─────────────────                        ────────────────────
boot.ts → loadModules()  ──import──→     src/index.ts (default export: AppstrateModule)
  module-loader.ts                         ├── init(ctx) — DB, Redis, migrations, billing sweeper
  ↓ success                                ├── hooks: { beforeUsage } — unified admission gate (run|chat)
  extendAppConfig → "cloud"                ├── events: { onOrgCreate, onOrgDelete } — free-tier + final drain + cleanup
  callHook("beforeUsage", ...)             ├── createRouter() — billing routes
  emitEvent("onOrgCreate", ...)            ├── openApiPaths / openApiTags — spec contribution
  ↓ failure (module absent)                ├── permissionsContribution() — `billing:read|manage` (level: "org")
                                           ├── principalPermissions — billing managers hold the same two
  OSS defaults, hooks are no-ops           ├── emailOverrides — branded transactional emails
                                           └── shutdown() — drain sweeper, close Redis + DB pool
```

Billing is NOT done in a hook. Cloud consumes the platform's append-only
`llm_usage` ledger with a **serial-`id` cursor** (`cloud_billing_cursor`): a
periodic sweeper reads `services.usage.list({ afterId })`, bills the settled
frontier, and advances the watermark. `beforeUsage` is only the read-only
admission (quota) gate — it turns the platform's neutral execution facts into a
credit **quote** and gates on the amount — and it fails **CLOSED**: when the
cloud DB is unreachable the hook returns `status: 500`, which blocks the
run/chat rather than admitting unmetered usage. That is a conscious availability
coupling (billing DB down ⇒ new usage paused).

**What the cursor does and does not guarantee.** Double-billing is impossible by
construction: a row is claimed exactly once (`cloud_billed_llm_usage` PK +
`ON CONFLICT DO NOTHING RETURNING`), the claim, the debit and the watermark
advance commit in ONE transaction, and the watermark is monotonic (`GREATEST`).
Claims are never purged, so even a deliberate operator rewind of the watermark
re-reads rows that debit nothing. A failed pass advances nothing and retries next
tick.

Misses are a different question, and the answer is "not by default — by
construction plus two explicit repairs":

- a row that commits **below an already-advanced watermark**. A serial `id` is
  assigned at INSERT but published at COMMIT, so the transaction holding id 100
  can commit after the one holding id 101: a pass sees 101, bills it, advances
  past 100, and `WHERE id > watermark` can never return row 100 again — unbilled
  and unlogged. Every pass therefore re-reads a bounded window BELOW the
  watermark (`CLOUD_RECONCILIATION_REPLAY_WINDOW`, default 200) rather than
  starting at it. The window is a READ offset only: the committed watermark
  stays `GREATEST`-monotonic, and a re-read row that was already claimed debits
  nothing. `replayBilled > 0` in the tick heartbeat warns — it is the proof the
  race is live in that deployment;
- a row whose org has **no billing account** cannot be debited. The pass records
  it, reports the org at `error` level and moves on (isolated, never fatal); the
  debt lives in `cloud_usage_records` until `bun run repair:account` applies it.
  This is reachable in production because org deletion drops the account while
  the platform refuses to delete an org with an active run;
- a row belonging to an org being **deleted** would vanish with the platform
  cascade before the next tick, so `onOrgDelete` runs a bounded final drain
  first (`billing/org-drain.ts`), out of band, without touching the global
  watermark;
- an **unsettled `system` row** stalls the cursor for every tenant until it
  settles. That is a delay, not a loss, and it warns on the first occurrence.
  Since the replay window, the blocking row can sit at the head **or below the
  watermark** — a late-committing row that replay recovered but that is not
  final yet. The below-watermark stall is deliberate and load-bearing: it pins
  the watermark so the row cannot age out of the replay window before it
  settles, which is why the window sizes the visibility race rather than the
  lifetime of a run. A fleet-wide delay is accepted to make the loss impossible.
  The heartbeat's `stalledBelowWatermark` says which kind you are looking at,
  because the diagnoses differ (frontier stall ⇒ a normal in-flight run;
  below-watermark stall ⇒ replay is holding for a recovered row).

### Cloud-owned tables

Cloud runs its **own** database (`CLOUD_DATABASE_URL`, separate from the platform DB). `migrateCloudDb` creates that database at boot when it is missing (through the server's `postgres` maintenance database, same credentials), so a dev box running only the OSS `docker-compose.dev.yml` needs no manual `createdb`; a role without `CREATEDB` gets an error naming the one-time command. All billing data lives in tables created by Cloud's own migrations — there is no FK to OSS tables, and the platform `llm_usage` ledger is read via the `ctx.services.usage` cursor (`list` / `settledFrontier`), never a cross-DB join:

- `cloud_billing_accounts` — plan, credits (used/quota), Stripe subscription status, customer/subscription IDs
- `cloud_usage_records` — per-context cost records keyed `(context_type, context_id)` — a run, a chat session, or the org's durable `(unattributed, orgId)` bucket. Carries both cumulative `cost_usd` (`numeric(24,12)`, the delta-billing basis) and the debited `cost_credits` (integer); the sweep bills `dollarsToCredits(cost_usd) − cost_credits` so sub-credit remainders carry forward instead of flooring to 0 each pass. `numeric`, not `double precision`: the `unattributed` bucket is one row per org that grows forever, and the sweep reconstructs the pre-pass cumulative as `cost_usd − delta` — both the accumulation and that reconstruction must be exact. Customer accounting data: never purged
- `cloud_billed_llm_usage` — idempotency claim: one marker per billed `llm_usage` row (PK `llm_usage_id`, `ON CONFLICT DO NOTHING`). Never purged — a `(integer, timestamptz)` row is small enough that keeping the full history is cheaper than any retention machinery, and keeping it is what makes an operator cursor re-seed harmless
- `cloud_billing_cursor` — single-row watermark: the highest `llm_usage.id` the sweep has processed. Monotonic for every code path (`GREATEST`); re-seeding it by hand stays available as an operator recovery, and cannot double-bill because the claims are still there
- `cloud_stripe_events` — webhook idempotency (claim + confirm pattern)
- `cloud_free_tier_claims` — anti-abuse for free tier (non-renewable per email)
- `cloud_billing_managers` — `(org_id, user_id, added_by, created_at)`, PK `(org_id, user_id)`: the org users granted `billing:*` without an admin role. `user_id` / `added_by` are `text` (the platform's `user.id` is text, not uuid); no FK, like every cloud table

### Exports

**Default export**: `AppstrateModule` — the module contract implementation (used by the platform's module loader).

**Named exports** (direct access for tests + custom integrations):

| Export               | Description                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QuotaExceededError` | Error class used internally by the `beforeUsage` hook (code: `QUOTA_EXCEEDED`, reason: `budget` / `status` / `no_account`). The hook maps `reason` to the wire code: `status` → `subscription_blocked`, `budget` / `no_account` → `quota_exceeded` (all 402) |
| `emailOverrides`     | Branded email templates overriding OSS defaults (verification, invitation, magic-link, reset-password)                                                                                                                                                       |

**Module hooks** (via `hooks` property):

| Hook          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeUsage` | Unified admission gate (first-match-wins), discriminated union over `run` \| `chat`. Returns `{ code, message, status }` rejection or `null`. Fires for **every** metered operation — the platform reports neutral facts (`credentialSource`, `executionPlane`, `timeoutSeconds`) and never pre-filters; this module quotes a model + compute estimate from them and gates on the total. Read-only: no billing here — the cursor sweep bills. |

**Module events** (broadcast-to-all, via `events` property):

| Event         | Description                                          |
| ------------- | ---------------------------------------------------- |
| `onOrgCreate` | Free tier credit allocation                          |
| `onOrgDelete` | Billing account cleanup + Stripe subscription cancel |

**Module features** (merged into `AppConfig.features` at boot):

| Flag           | Meaning                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing`      | The billing surface exists — the dashboard renders plan/usage/checkout                                                                                                                                                                      |
| `custom_roles` | Licenses the platform's own `POST/PATCH/DELETE /api/roles` (RBAC spec §9). The space-role data model, the four presets and the read routes are OSS; DEFINING a custom bundle is the EE half, and cloud is the module that licenses it today |

> **Signup gating is no longer cloud-owned.** Domain allowlist (`AUTH_ALLOWED_SIGNUP_DOMAINS`), invitation-only signup (`AUTH_DISABLE_SIGNUP`), platform-admin allowlist (`AUTH_PLATFORM_ADMIN_EMAILS`), and bootstrap-owner auto-org (`AUTH_BOOTSTRAP_OWNER_EMAIL`) all live natively in the platform's `evaluateSignupPolicy` since PR #282. The `beforeSignup` hook + `DomainNotAllowedError` were removed from cloud in this PR.

## Stack

Same as appstrate (Bun, Hono, Drizzle, PostgreSQL, Redis). Additional dependencies:

- **Stripe** (`stripe` SDK) — checkout, customer portal, webhooks
- **ioredis** — rate limiting middleware (separate connection from BullMQ, `cloud:` key prefix)

## Code Structure

```
cloud/
├── src/
│   ├── index.ts              # Default: AppstrateModule + named: QuotaExceededError, emailOverrides
│   ├── openapi.ts            # OpenAPI 3.1 contribution: paths + tags + component schemas for billing routes
│   ├── config.ts             # Plan definitions (free/starter/pro), credit quotas, DEFAULT_QUOTE_RATES (compute rates ship at 0)
│   ├── env.ts                # Zod-validated Cloud env vars (Stripe keys)
│   ├── db.ts                 # Drizzle client (lazy init, own CLOUD_DATABASE_URL)
│   ├── redis.ts              # ioredis client (lazy init, cloud: prefix)
│   ├── logger.ts             # Creates and exports a pino logger instance via @appstrate/core/logger createLogger()
│   ├── middleware.ts          # Rate limiting + admin guard for Cloud routes
│   ├── platform-org-queries.ts # The two org queries cloud needs from the platform + CloudInitContext
│   ├── billing/
│   │   ├── managers.ts        # Billing managers: resolver, set replacement, principal-permission invalidation
│   │   ├── contact.ts         # Billing contact: read/patch + Stripe customer email push
│   │   ├── usage-quote.ts     # Pure quoteUsage(params, rates) → { modelCredits, computeCredits, totalCredits } + version-skew guard
│   │   ├── quota-check.ts     # Account read + entitlement gate; balance rule in pure isAffordable() (throws QuotaExceededError)
│   │   ├── usage-recorder.ts  # Cursor sweep pass: claim + debit + advance watermark (one txn) + billLedgerRows primitive
│   │   ├── billing-sweeper.ts # Periodic timer driving the cursor sweep + tick observability + throttled entitlement resync
│   │   ├── org-drain.ts       # Bounded final drain of ONE org's usage on deletion (never moves the watermark)
│   │   ├── repair-account.ts  # Re-provision a missing billing account and apply its recorded debt
│   │   └── storage-entitlement.ts # Plan → platform file-storage limit projection (setFileStorageLimit)
│   ├── stripe/
│   │   ├── client.ts         # Stripe SDK singleton
│   │   ├── checkout.ts       # Stripe Checkout session creation
│   │   ├── portal.ts         # Stripe Customer Portal session creation
│   │   └── webhooks.ts       # Webhook processing (idempotent, handles subscription lifecycle)
│   ├── credits.ts            # Dollar-to-credits conversion (centralized, will evolve)
│   ├── emails/
│   │   ├── types.ts          # Local type definitions (mirrors @appstrate/emails contracts)
│   │   ├── layout.ts         # Cloud-branded layout (dark theme, logo, footer)
│   │   ├── recipients.ts     # Who a billing email goes to (contact ∪ CC ∪ managers)
│   │   └── templates/        # Branded email templates (verification, invitation)
│   ├── onboarding/
│   │   └── post-signup.ts    # Free tier credit allocation + final drain / Stripe cancel on org deletion
│   ├── scripts/
│   │   └── repair-account.ts # CLI: bun run repair:account -- <orgId> <ownerEmail>
│   └── routes/
│       └── billing.ts        # GET /billing, POST /checkout, POST /portal, POST /webhooks,
│                              #   GET|PUT /billing/managers, GET|PATCH /billing/contact
├── drizzle/
│   ├── schema.ts             # Billing tables (Drizzle ORM)
│   ├── drizzle.config.ts     # Drizzle Kit config (tablesFilter: cloud_* tables only)
│   └── migrations/           # SCHEMA only — incremental & re-runnable (production data exists)
├── scripts/
│   ├── verify-no-migration-dml.ts # Gate: no data repair in drizzle/migrations/ (part of `check`)
│   └── migration/            # One-off data repairs, run by an operator — never replayed
├── package.json
├── tsconfig.json
└── eslint.config.js
```

## Billing Model

Plans define quotas in **integer credits** (not floats, not dollars). All DB columns (`credits_used`, `credit_quota`, `cost_credits`) are `integer` storing credits. Conversion: 1 dollar = 1000 credits — one `CREDITS_PER_DOLLAR` constant in `src/credits.ts` (will evolve). The billing sweep reads each `llm_usage` row's `cost_usd` from the platform cursor and converts to credits via `dollarsToCredits()`. Frontend displays credits and usage percentage.

| Plan    | Credits | Display | Price  |
| ------- | ------- | ------- | ------ |
| free    | 5,000   | 5K cr.  | $0/mo  |
| starter | 20,000  | 20K cr. | $29/mo |
| pro     | 80,000  | 80K cr. | $99/mo |

Each plan has a `tier` (0/1/2) for upgrade ordering and a `name` for display.

### Subscription status sync

The `subscriptionStatus` field caches Stripe's status while a subscription is attached; `customer.subscription.deleted` normalizes it to `null`, the canonical free/no-subscription state, without re-granting credits. Admission distinguishes hard service blocks (`unpaid`, `paused`) from ended paid entitlements (`canceled`, `incomplete_expired`). Hard blocks reject every quote. Ended entitlements still admit an exact-zero quote (for example platform BYOK while compute is unbilled) but reject any positive quote with `subscription_blocked`. `past_due` remains allowed as a grace period during Stripe dunning retries. These sets are centralized in `config.ts` (`HARD_BLOCKED_STATUSES`, `ENDED_SUBSCRIPTION_STATUSES`, `WARNING_STATUSES`).

### Billing flow (admission gate + cursor sweep)

```
beforeUsage(params)                              // returns rejection or null
  run:  { orgId, context:"run",  packageId, runningCount,
          credentialSource:"system"|"org"|null, executionPlane:"platform"|"remote",
          timeoutSeconds: number|null }          // effective, post-ceiling
  chat: { orgId, context:"chat", sessionId, credentialSource, executionPlane:"platform" }

  → VERSION-SKEW GUARD (first, before everything): facts absent or out-of-union
      → log at error level and rewrite to the WORST case (system credential +
        platform compute). Never short-circuit and never quote on unusable facts
  → SELF-FUNDED SHORT-CIRCUIT: credentialSource !== "system" && executionPlane
      !== "platform" (a remote BYOK run) → return null BEFORE any billing DB
      read — such an org may legitimately have no billing account at all
  → quoteUsage(params, DEFAULT_QUOTE_RATES) — pure, per-component, ceil per part
    · modelCredits   = credentialSource === "system"
                         ? (run ? ESTIMATED_MODEL_CREDITS_PER_RUN × runningCount
                                : ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN)
                         : 0
    · computeCredits = executionPlane === "platform"
                         ? (run ? (timeoutSeconds === null ? 0        // seam does
                                     : COMPUTE_CREDITS_PER_RUN_SECOND  // not own
                                       × timeoutSeconds)               // this run's
                                : COMPUTE_CREDITS_PER_CHAT_TURN)       // compute
                         : 0
    · total = modelCredits + computeCredits
    COMPUTE RATES SHIP AT 0 — compute is not charged yet. Flipping them to a
    non-zero value is the ONLY change needed to start gating on compute: no new
    hook, no new core field, no change to where admission fires.
  → checkQuota(orgId, quote) — reads the account, then in this order:
    · no_account → reject ONLY if total > 0 (a missing account cannot owe)
    · status     → unpaid/paused reject every quote; canceled/incomplete_expired
                   reject only when total > 0 (exact-zero BYOK remains available)
    · budget     → isAffordable(quote, account): remaining = max(0, quota − used);
                   reject iff total > remaining (equal FITS and is admitted)
  → on error: { code: "subscription_blocked" | "quota_exceeded", message, status: 402 }
      status → subscription_blocked · budget/no_account → quota_exceeded

… usage happens; the platform appends rows to its llm_usage ledger …

billing sweeper (periodic, cursor over llm_usage.id):
  → each tick DRAINS consecutive full batches (a backlog is worked down within
      one tick, not one batch per interval) — keep sweeping while the last pass
      filled its batch AND advanced the cursor, bounded by MAX_DRAIN_ITERATIONS
      (50) so the tick stays finite; a short batch or a head-of-line stall stops it
  → services.usage.list({ afterId: cursor − REPLAY_WINDOW }) — one batch per pass,
      id ASC. Scans BELOW the watermark (clamped at 0) because a serial id is taken
      at INSERT and published at COMMIT: a row can commit below an already-advanced
      watermark and would otherwise be unreachable forever. READ offset only — the
      watermark itself never rewinds. The replay span is read ON TOP of the batch
      (limit = span + batch, ≤ 1000, the platform's usage.list hard cap), so the
      forward slice keeps its full CLOUD_RECONCILIATION_BATCH_SIZE
  → frontier = leading rows the watermark may pass: settled rows always; an
      UNSETTLED row stalls ONLY if credentialSource === "system" (billed once it
      settles). Unsettled NON-system rows (BYOK/null) are advanced PAST (never
      billed; credentialSource is immutable) so a long BYOK run can't wedge billing.
      The blocking row may sit BELOW the watermark (a late-committing row replay
      recovered): intended — the stall is what keeps it inside the replay window
      until it settles. stalledBelowWatermark tells the two apart.
  → for each SETTLED row with credentialSource === "system":
      claim into cloud_billed_llm_usage (ON CONFLICT DO NOTHING)
      per (context_type, context_id): cost_usd += cost_usd; debit the DELTA
      dollarsToCredits(new cost_usd) − prior cost_credits (remainder carries forward)
      null-context rows join the org's DURABLE (unattributed, orgId) bucket, so
      they obey the exact same carry-forward rule — no remainder is dropped
      an org with NO billing account is isolated: usage recorded, `error` logged
      with its id, pass commits (see `repair:account`) — never fatal
  → advance cloud_billing_cursor in the SAME transaction; on error nothing advances (retry next tick)
  → one structured heartbeat per tick: processed / billed / alreadyBilled /
      replayed / replayBilled / orphanedOrgs / cursorTo / stalledOnId /
      stalledBelowWatermark (a cursorTo that stands still across ticks is the
      "billing is behind" signal;
      replayBilled > 0 warns — revenue recovered from below the watermark;
      alreadyBilled counts re-reads ABOVE the watermark only, so the replay
      window does not make that warning fire every tick)
  → then STARTS (never awaits) the throttled storage-entitlement reconcile

org deletion (onOrgDelete, awaited by the platform BEFORE its cascade):
  → bounded final drain of that org's settled system rows, out of band
      (never moves the global watermark; the sweep later finds them claimed)
  → then Stripe subscription cancel + delete the org's cloud rows
```

Only platform-provided models (`credentialSource === "system"`) are billed; org-credential (BYOK) and null-credential rows advance the watermark but are never debited. **Runner rows are cumulative** (one growing row per run) and only settle at a terminal run status — the sweep never advances past an unsettled _system_ row, so a mid-run system row is billed only once it is final. Cutover: the cursor is seeded to the platform's **settled frontier** (`usage.settledFrontier()` — the highest id below which every row is settled, NOT a plain max id, which would strand an in-flight runner row already holding a low id) **synchronously in the module's `init()`, at boot before the server takes traffic** (`ensureCursorSeeded`, shared with an in-sweep safety-net fallback). Seeding at init rather than at the first sweep tick closes the loss window: usage recorded between boot and that first tick (~5 min) is billed by the tick instead of falling below a watermark only set at the tick. Rows already claimed by the previous model are never re-billed — the claim table dedupes. But because the first sweep starts at the settled frontier, settled-but-unclaimed rows ABOVE it (the recent window since the oldest in-flight run began) ARE billed on the first pass — deliberate, so an in-flight run's revenue is not stranded; rows below the frontier are never revisited.

See `docs/architecture/CLOUD_BILLING_SPEC.md` for the full implementation spec.

#### Known over-quote on the system-proxy seam (accepted)

Two platform seams dispatch the `run` variant, and they meter different units.
The preflight gate admits one run **launch**; the system-proxy seam admits one
raw `/api/llm-proxy` **call** of an already-running run (recognisable by
`timeoutSeconds: null`). `ESTIMATED_MODEL_CREDITS_PER_RUN` is a per-run rate, so
on the second seam it is charged per call — an agent making many proxy calls is
quoted far above what it will consume. The direction is safe (a soft cap that
over-gates, never under-gates) and the fix is deliberately deferred: it needs a
unit discriminant (launch vs. call) on `BeforeUsageParams`, i.e. a core contract
change. The comment sits on the multiplication in `billing/usage-quote.ts`.

### Billing managers and billing contact

Two separate things, both owned by cloud (RBAC spec §10) — one is about WHO may
act on billing, the other about WHERE the paperwork goes.

**Billing managers.** Org users who hold `billing:read` + `billing:manage`
without being owners or admins. The grant is not an org role: `billing` is cloud
vocabulary and core's `org_role` enum is Apache-2.0, so a `billing_manager` role
would put the one inside the other. It travels instead through the module
contract's `principalPermissions` member — `mayGrant: ["billing:read",
"billing:manage"]` plus a resolver that is one primary-key lookup into
`cloud_billing_managers`. The platform caches each principal's answer for 10s
and CANNOT know when that table changed, so every write in
`billing/managers.ts` calls `invalidatePrincipalPermissions(orgId, userId)` for
each principal it touched — added AND removed, since a stale cache is wrong in
both directions.

`PUT /api/billing/managers` replaces the whole set (the dashboard edits a list
and saves it, so two concurrent saves resolve to one of the two lists rather
than to a merge neither chose) and refuses two things with a 400:

- a user id that is **not a member of the org** — checked through
  `ctx.getOrgMembers`, never a cross-DB join, because cloud has no access to the
  platform's membership table;
- an **owner or admin**, who already holds both strings by role. Accepting it
  would write a row that grants nothing and, worse, leave a list the org reads
  as "these people can act on billing" while the people who actually can are the
  ones missing from it.

**Billing contact.** `cloud_billing_accounts.billing_email` (nullable) plus
`billing_cc text[]` (capped at 5 by the route, not by a CHECK — the cap is a
product decision that may move). `GET`/`PATCH /api/billing/contact`, both
`billing:manage`. Neither address has to belong to a platform user: "send the
invoices to accounting@" is the case this exists for.

`billing_email` NULL is not "unset, nothing happens" — it falls back to the
org's OWNERS, resolved at send time through `ctx.getOrgOwnerEmails`. A live
fallback rather than a copied default, so an org that changes owners keeps
reaching a real person. At org creation `onOrgCreate` seeds it with the
creator's address **as typed**, not `normalizeEmail`'s output: normalization
strips plus- and dot-addressing to make the free-tier claim hard to alias, which
is the right rule for a claim key and the wrong one for an address a human
reads.

Two consumers:

- **Stripe.** `customers.create({ email, metadata })` at checkout and
  `customers.update({ email })` when the contact moves, both using
  `billing_email ?? the org's first owner`. Without it Stripe has no address at
  all and every payment notice depends on cloud noticing the webhook first. The
  update is best-effort and runs AFTER the local commit — the contact is cloud's
  record, and a Stripe outage must not refuse an address change.
- **`sendBillingEmail`.** Recipients are
  `billing_email ?? owner emails` ∪ `billing_cc` ∪ emails of billing managers,
  composed by the pure `composeBillingRecipients` in `emails/recipients.ts`
  (de-duplicated case-insensitively, first spelling wins). This replaced a
  fan-out to every org admin: an admin runs agents, a billing contact pays for
  them, and the two are routinely different people. `getOrgAdminEmails` is
  **deleted** from `ModuleInitContext`, not kept as a fallback.

**What the platform must provide** (`ModuleInitContext`, core 10.0.0):
`getOrgOwnerEmails(orgId)` and `getOrgMembers(orgId, userIds)` — the latter
resolves ids to `{ userId, email, role }` and simply OMITS an id that is not a
member of that org, which is what makes one call serve both the membership
refusal above and the manager address book. `src/platform-org-queries.ts`
declares them and narrows `init`'s parameter to `CloudInitContext`, so the
requirement sits in the signature rather than in a comment.

### Storage-entitlement reconcile

`resyncAllStorageEntitlements` blind-rewrites every account's platform storage
limit — the backfill for orgs created before the feature and the repair loop for
transition syncs that failed. It rides the billing tick on an hourly throttle,
**started but never awaited**: the tick's completion schedules the next sweep, so
awaiting a fleet-wide pass here would delay billing. The pass is
concurrency-bounded internally (8 orgs at a time) and a pass that left orgs
unrepaired logs at `error`; the next window simply repeats the idempotent
rewrite. `shutdown()` drains it along with the sweep.

### Operator recovery

```sh
bun run repair:account -- <orgId> <ownerEmail>
```

Re-provisions a missing `cloud_billing_accounts` row (idempotent, reuses the same
free-tier claim path so no second free tier is minted) and applies the debt the
sweep recorded while the account was absent
(`credits_used = SUM(cloud_usage_records.cost_credits)`). Refuses an org that
already has an account — that sum is only the un-debited debt for a brand-new
account, since a Stripe renewal resets `credits_used` while usage records remain.

The sum is the only way to apply that debt: the orphaned ledger rows were claimed
and the watermark advanced past them in the same committed transaction that
recorded them, so no future sweep can ever read them again.

### One-off data repair

`drizzle/migrations/*.sql` describes the **schema** and is replayed on every
cloud database forever. A one-off rewrite of row **contents** is not schema — it
goes in `scripts/migration/<NNNN>-<slug>.{sql,ts}` and is run deliberately by an
operator (see that directory's README; the platform's
`docs/NO_TRANSITIONAL_CODE.md` §2 is the authority). `bun run verify:no-migration-dml`,
part of `check`, fails a new migration that writes rows unless a `SET NOT NULL` /
`CHECK` / `VALIDATE CONSTRAINT` on the **same table** in the same file licences
it. `0001_cursor_billing` and `0003_normalize_free_subscription_status` predate
the gate and are grandfathered by name — that list may shrink, never grow.

## Testing

```sh
bun run test           # Unit then integration — the exact command CI runs
bun test               # Everything in one process
bun run test:unit      # Unit tests only (test/unit/) — no external dependencies
bun run test:integration  # Integration tests only (test/integration/)
```

- **Unit tests** (`test/unit/`): config, env validation, init logic
- **Integration tests** (`test/integration/`): middleware, routes, services. No
  external setup needed — the preload (`test/setup/preload.ts`) brings up its own
  PostgreSQL (:5434) + Redis (:6381) via Docker Compose, sets every env var, and
  initializes the module (which self-migrates).

CI runs both: `.github/workflows/check.yml` has a `test` job on every PR, and
`release.yml` gates the tag on a `verify` job (`check` + tests) before any image
is built.
