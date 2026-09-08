# `@appstrate/module-ee`

The commercial module: Stripe billing, credit quotas, usage metering, billing
managers, and the licence gate on custom space roles.

**This directory is not Apache-2.0.** It is source-available under the Appstrate
Commercial License in `LICENSE` beside this file — readable and contributable,
but production use needs a written agreement. Every `.ts` file carries
`// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial`, and
`bun run verify:license-boundary` fails the build if one does not.

## In this monorepo

- **Opt-in.** Append `@appstrate/module-ee` to `MODULES`. Absent from that list
  the module is never imported and contributes nothing — no routes, no
  `billing:*` permission strings, no Stripe code loaded. It ships inert in the
  platform image, exactly like the other opt-in modules.
- **Its own database.** `EE_DATABASE_URL`, separate from the platform's, created
  automatically at first boot when the role has `CREATEDB`. Plus the four
  `STRIPE_*` variables; all five are validated by this module's own Zod schema
  (`src/env.ts`) and documented in `docs/ENV.md`.
- **Tests** run under the repository's harness — see "Testing" at the bottom.
- **No lockstep.** `@appstrate/core` is a `workspace:*` dependency, so there is
  no npm publish, no version gate and no peer range to keep in step.

## Architecture

EE implements the `AppstrateModule` contract from `@appstrate/core/module`. The platform loads it via dynamic import at boot through the module system (`apps/api/src/lib/modules/`). The module must be declared in `MODULES` env var — all declared modules are required (if declared but not installed, the platform crashes at boot with a clear error).

```
appstrate (OSS)                          EE (this module)
─────────────────                        ────────────────────
boot.ts → loadModules()  ──import──→     src/index.ts (default export: AppstrateModule)
  module-loader.ts                         ├── init(ctx) — DB, Redis, migrations, billing sweeper
  ↓ success                                ├── hooks: { beforeUsage } — unified admission gate (run|chat)
  extendAppConfig → "ee"                   ├── events: { onOrgCreate, onOrgDelete } — free-tier + final drain + cleanup
  callHook("beforeUsage", ...)             ├── createRouter() — billing routes
  emitEvent("onOrgCreate", ...)            ├── openApiPaths / openApiTags — spec contribution
  ↓ failure (module absent)                ├── permissionsContribution() — `billing:read|manage` (level: "org")
                                           ├── principalPermissions — billing managers hold the same two
  OSS defaults, hooks are no-ops           ├── emailOverrides — branded transactional emails
                                           └── shutdown() — drain sweeper, close Redis + DB pool
```

Billing is NOT done in a hook. EE consumes the platform's append-only
`llm_usage` ledger with a **serial-`id` cursor** (`ee_billing_cursor`): a
periodic sweeper reads `services.usage.list({ afterId })`, bills the settled
frontier, and advances the watermark. `beforeUsage` is only the read-only
admission (quota) gate — it turns the platform's neutral execution facts into a
credit **quote** and gates on the amount — and it fails **CLOSED**: when the
EE DB is unreachable the hook returns `status: 500`, which blocks the
run/chat rather than admitting unmetered usage. That is a conscious availability
coupling (billing DB down ⇒ new usage paused).

**What the cursor does and does not guarantee.** Double-billing is impossible by
construction: a row is claimed exactly once (`ee_billed_llm_usage` PK +
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
  debt lives in `ee_usage_records` until `bun run repair:account` applies it.
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

### EE-owned tables

This module runs its **own** database (`EE_DATABASE_URL`, separate from the platform DB). `migrateEeDb` creates that database at boot when it is missing (through the server's `postgres` maintenance database, same credentials), so a dev box running only the OSS `docker-compose.dev.yml` needs no manual `createdb`; a role without `CREATEDB` gets an error naming the one-time command. All billing data lives in tables created by EE's own migrations — there is no FK to OSS tables, and the platform `llm_usage` ledger is read via the `ctx.services.usage` cursor (`list` / `settledFrontier`), never a cross-DB join:

- `ee_billing_accounts` — plan, credits (used/quota), Stripe subscription status, customer/subscription IDs
- `ee_usage_records` — per-context cost records keyed `(context_type, context_id)` — a run, a chat session, or the org's durable `(unattributed, orgId)` bucket. Carries both cumulative `cost_usd` (`numeric(24,12)`, the delta-billing basis) and the debited `cost_credits` (integer); the sweep bills `dollarsToCredits(cost_usd) − cost_credits` so sub-credit remainders carry forward instead of flooring to 0 each pass. `numeric`, not `double precision`: the `unattributed` bucket is one row per org that grows forever, and the sweep reconstructs the pre-pass cumulative as `cost_usd − delta` — both the accumulation and that reconstruction must be exact. Customer accounting data: never purged
- `ee_billed_llm_usage` — idempotency claim: one marker per billed `llm_usage` row (PK `llm_usage_id`, `ON CONFLICT DO NOTHING`). Never purged — a `(integer, timestamptz)` row is small enough that keeping the full history is cheaper than any retention machinery, and keeping it is what makes an operator cursor re-seed harmless
- `ee_billing_cursor` — single-row watermark: the highest `llm_usage.id` the sweep has processed. Monotonic for every code path (`GREATEST`); re-seeding it by hand stays available as an operator recovery, and cannot double-bill because the claims are still there
- `ee_stripe_events` — webhook idempotency (claim + confirm pattern)
- `ee_free_tier_claims` — anti-abuse for free tier (non-renewable per email)
- `ee_billing_managers` — `(org_id, user_id, added_by, created_at)`, PK `(org_id, user_id)`: the org users granted `billing:*` without an admin role. `user_id` / `added_by` are `text` (the platform's `user.id` is text, not uuid); no FK, like every EE table

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

| Flag           | Meaning                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing`      | The billing surface exists — the dashboard renders plan/usage/checkout                                                                                                                                                                   |
| `custom_roles` | Licenses the platform's own `POST/PATCH/DELETE /api/roles` (RBAC spec §9). The space-role data model, the four presets and the read routes are OSS; DEFINING a custom bundle is the EE half, and EE is the module that licenses it today |

> **Signup gating is no longer EE-owned.** Domain allowlist (`AUTH_ALLOWED_SIGNUP_DOMAINS`), invitation-only signup (`AUTH_DISABLE_SIGNUP`), platform-admin allowlist (`AUTH_PLATFORM_ADMIN_EMAILS`), and bootstrap-owner auto-org (`AUTH_BOOTSTRAP_OWNER_EMAIL`) all live natively in the platform's `evaluateSignupPolicy` since PR #282. The `beforeSignup` hook + `DomainNotAllowedError` were removed from EE in this PR.

## Stack

The repository's (Bun, Hono, Drizzle, PostgreSQL, Redis), plus:

- **Stripe** (`stripe` SDK) — checkout, customer portal, webhooks
- **ioredis** — rate limiting middleware (separate connection from BullMQ, `EE:` key prefix)

## Code Structure

```
packages/module-ee/
├── src/
│   ├── index.ts              # Default: AppstrateModule + named: QuotaExceededError, emailOverrides
│   ├── openapi.ts            # OpenAPI 3.1 contribution: paths + tags + component schemas for billing routes
│   ├── config.ts             # Plan definitions (free/starter/pro), credit quotas, DEFAULT_QUOTE_RATES (compute rates ship at 0)
│   ├── env.ts                # Zod-validated EE env vars (Stripe keys)
│   ├── db.ts                 # Drizzle client (lazy init, own EE_DATABASE_URL)
│   ├── redis.ts              # ioredis client (lazy init, EE: prefix)
│   ├── logger.ts             # Creates and exports a pino logger instance via @appstrate/core/logger createLogger()
│   ├── middleware.ts          # Rate limiting + admin guard for EE routes
│   ├── platform-org-queries.ts # The two org queries EE needs from the platform + EeInitContext
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
│   │   ├── layout.ts         # EE-branded layout (dark theme, logo, footer)
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
│   ├── drizzle.config.ts     # Drizzle Kit config (tablesFilter: ee_* tables only)
│   └── migrations/           # SCHEMA only — incremental & re-runnable (production data exists)
├── scripts/migration/        # One-off data repairs, run by an operator — never replayed
├── test/                     # Runs under the repository's test harness — see "Testing"
├── LICENSE                   # Appstrate Commercial License — NOT Apache-2.0
├── package.json
└── tsconfig.json
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
      claim into ee_billed_llm_usage (ON CONFLICT DO NOTHING)
      per (context_type, context_id): cost_usd += cost_usd; debit the DELTA
      dollarsToCredits(new cost_usd) − prior cost_credits (remainder carries forward)
      null-context rows join the org's DURABLE (unattributed, orgId) bucket, so
      they obey the exact same carry-forward rule — no remainder is dropped
      an org with NO billing account is isolated: usage recorded, `error` logged
      with its id, pass commits (see `repair:account`) — never fatal
  → advance ee_billing_cursor in the SAME transaction; on error nothing advances (retry next tick)
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
  → then Stripe subscription cancel + delete the org's EE rows
```

Only platform-provided models (`credentialSource === "system"`) are billed; org-credential (BYOK) and null-credential rows advance the watermark but are never debited. **Runner rows are cumulative** (one growing row per run) and only settle at a terminal run status — the sweep never advances past an unsettled _system_ row, so a mid-run system row is billed only once it is final. Cutover: the cursor is seeded to the platform's **settled frontier** (`usage.settledFrontier()` — the highest id below which every row is settled, NOT a plain max id, which would strand an in-flight runner row already holding a low id) **synchronously in the module's `init()`, at boot before the server takes traffic** (`ensureCursorSeeded`, shared with an in-sweep safety-net fallback). Seeding at init rather than at the first sweep tick closes the loss window: usage recorded between boot and that first tick (~5 min) is billed by the tick instead of falling below a watermark only set at the tick. Rows already claimed by the previous model are never re-billed — the claim table dedupes. But because the first sweep starts at the settled frontier, settled-but-unclaimed rows ABOVE it (the recent window since the oldest in-flight run began) ARE billed on the first pass — deliberate, so an in-flight run's revenue is not stranded; rows below the frontier are never revisited.

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

Two separate things, both owned by EE (RBAC spec §10) — one is about WHO may
act on billing, the other about WHERE the paperwork goes.

**Billing managers.** Org users who hold `billing:read` + `billing:manage`
without being owners or admins. The grant is not an org role: `billing` is EE
vocabulary and core's `org_role` enum is Apache-2.0, so a `billing_manager` role
would put the one inside the other. It travels instead through the module
contract's `principalPermissions` member — `mayGrant: ["billing:read",
"billing:manage"]` plus a resolver that is one primary-key lookup into
`ee_billing_managers`. The platform caches each principal's answer for 10s
and CANNOT know when that table changed, so every write in
`billing/managers.ts` calls `invalidatePrincipalPermissions(orgId, userId)` for
each principal it touched — added AND removed, since a stale cache is wrong in
both directions.

`PUT /api/billing/managers` replaces the whole set (the dashboard edits a list
and saves it, so two concurrent saves resolve to one of the two lists rather
than to a merge neither chose) and refuses two things with a 400:

- a user id that is **not a member of the org** — checked through
  `ctx.getOrgMembers`, never a cross-DB join, because EE has no access to the
  platform's membership table;
- an **owner or admin**, who already holds both strings by role. Accepting it
  would write a row that grants nothing and, worse, leave a list the org reads
  as "these people can act on billing" while the people who actually can are the
  ones missing from it.

**Billing contact.** `ee_billing_accounts.billing_email` (nullable) plus
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
  all and every payment notice depends on EE noticing the webhook first. The
  update is best-effort and runs AFTER the local commit — the contact is EE's
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
declares them and narrows `init`'s parameter to `EeInitContext`, so the
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

Re-provisions a missing `ee_billing_accounts` row (idempotent, reuses the same
free-tier claim path so no second free tier is minted) and applies the debt the
sweep recorded while the account was absent
(`credits_used = SUM(ee_usage_records.cost_credits)`). Refuses an org that
already has an account — that sum is only the un-debited debt for a brand-new
account, since a Stripe renewal resets `credits_used` while usage records remain.

The sum is the only way to apply that debt: the orphaned ledger rows were claimed
and the watermark advanced past them in the same committed transaction that
recorded them, so no future sweep can ever read them again.

### One-off data repair

`drizzle/migrations/*.sql` describes the **schema** and is replayed on every
EE database forever. A one-off rewrite of row **contents** is not schema — it
goes in `scripts/migration/<NNNN>-<slug>.{sql,ts}` and is run deliberately by an
operator (see that directory's README; `docs/NO_TRANSITIONAL_CODE.md` §2 at the
repository root is the authority). The root `bun run verify:no-migration-dml`
scans this directory alongside the platform's and fails a new migration that
writes rows unless a `SET NOT NULL` / `CHECK` / `VALIDATE CONSTRAINT` on the
**same table** in the same file licences it. `0001_cursor_billing` and
`0003_normalize_free_subscription_status` predate the gate and are listed in
`EE_GRANDFATHERED` — that list may shrink, never grow.

## Testing

```sh
bun test packages/module-ee              # from the repository root
cd packages/module-ee && bun test        # same thing, same root preload
```

The root preload (`test/setup/preload.ts`) discovers this package like any other
`packages/module-*`, applies the env in `test/requirements.ts`, and runs the real
`init(ctx)` against the platform's test PostgreSQL — the module migrates its own
`appstrate_test_ee` database on the way. Two consequences worth knowing:

- `test/requirements.ts` declares `{ postgres: true }`, so under `TEST_TIER=0`
  (`bun run test:tier0`) the module is not imported, not initialized, and its
  test files are not collected. It needs `CREATE DATABASE` and `postgres.js`,
  neither of which the tier-0 PGlite adapter offers. The runner prints the skip.
- the same file sets `CLOUD_RECONCILIATION_INTERVAL_SECONDS=0` so `init()` arms
  no periodic sweep — a timer firing mid-suite would bill rows a test seeded.
  The sweep functions are driven directly by
  `test/integration/services/billing-sweeper.test.ts`.

`test/helpers/setup.ts` installs the two seams these tests drive themselves: the
in-memory `llm_usage` ledger (`mock-platform.ts`) in place of the real
`services.usage`, and the in-memory org directory (`org-queries.ts`) in place of
the platform's member lookups. Both are plain setters, not mocks. Every
integration test file calls `useEeTestSeams()` at the top; it is idempotent.
`test/tables.ts` is empty on purpose — this module's tables are in another
database, so `truncateAll()` has nothing of its to clear (`test/helpers/db.ts`
clears them instead).
