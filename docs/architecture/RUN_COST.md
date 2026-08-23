# Run Cost Tracking

Extracted from `CLAUDE.md` Backend section. Canonical read path + ingestion chains for `runs.cost`.

## The two invariants

- **Single writer**: every `llm_usage` row is inserted by `recordLlmUsage` (`apps/api/src/services/llm-usage-ledger.ts`). No producer builds its own `db.insert(llmUsage)`.
- **Single read path**: aggregate run spend is `computeRunSpend(runId, orgId)` (`apps/api/src/services/state/runs.ts`), which SUMs the ledger AND reports what that sum is worth (see _Pricing provenance_). No caller SUMs it directly. `runs.cost` / `runs.cost_pricing_status` are those two values, cached at terminal time.

## Ingestion — four producers, one ledger

1. **Platform-side runs (Pi container)**: `SYSTEM_PROVIDER_KEYS` cost config → `ModelDefinition.cost` → `ResolvedModel.cost` → `PromptContext.llmConfig.cost` → snapshotted at kickoff onto `runs.model_cost` → the runner's cumulative token counters arrive on the `appstrate.metric` event → **one cumulative `source="runner"` row per run** (`writeRunnerLedgerRow`), priced `cost_usd = Σ(tokens × runs.model_cost / 1e6)` **server-side** by the same `computeTokenCost` the proxy meter uses. The container computes a cost of its own too (`MODEL_COST` env var → Pi SDK `calculateCost` → `RunMessage.cost`), but the platform does NOT record it: the number billing debits credits from must not be produced inside the sandbox the platform is isolating, and the platform already holds both factors. The reported figure is kept only as a cutover instrument: at the terminal ledger barrier — once per run, so the line carries the run's full cumulative gap rather than one prefix of it per metric event — a divergence beyond 1e-6 USD logs `llm_usage: runner-reported cost diverges from the server-computed cost`; and it is also what unblocks masking `MODEL_COST` for aliased models, whose published rate card would otherwise identify the vendor the alias exists to hide. DB models (`org_models`) also support an optional `cost` (jsonb); OpenRouter models auto-populate it from the pricing API. The dashboard exposes no pricing fields (operator-only, by design); `PUT /api/models/{id}` with `{"cost": {...}}` sets the override and `{"cost": null}` clears it back to the catalog.
2. **Server-side proxy (`/api/llm-proxy/*`, remote runs + chat's API-key turns)**: resolves the preset, forwards upstream, and inserts **one `source="proxy"` row per call**, `cost_usd = Σ(tokens × ResolvedModel.cost / 1e6)` over the four buckets. Pricing comes from `ModelDefinition.cost`, identical to the platform chain.
3. **Runner reconciliation at finalize**: `POST /api/runs/{runId}/events/finalize` writes the run's terminal cumulative snapshot through the same `writeRunnerLedgerRow` upsert (see _Terminal ledger barrier_ below).
4. **In-process chat engine** (`chat-subscription.ts:recordChatUsage`): the Pi chat engine drives every chat turn, but only its oauth-subscription branch (claude-code, codex) talks to the provider directly; that branch never traverses the proxy, so it meters its own turn — one row per turn, attributed by `chat_session_id`, always `credential_source="org"` (it spends the user's own subscription), priced by the same `computeTokenCost`. It is stamped `source="proxy"`, which is a **known labelling inaccuracy**: the enum has only `proxy | runner`, and `proxy` is the correct half of that pair here because the row is immutable at insert (see _Settlement_). A dedicated third enum value would need a DB enum migration plus a `PlatformServices` contract change.

**Audit-only**: `credential_proxy_usage` rows have `cost_usd = 0` and are intentionally NOT summed into `runs.cost` — per-call audit only.

## Token buckets — one normalisation, two implementations

Cost is `input×input_rate + output×output_rate + cacheRead×cacheRead_rate + cacheWrite×cacheWrite_rate` over four **disjoint** buckets (`computeTokenCost`, `@appstrate/afps-runtime/runner`). The same upstream reply is normalised into those buckets twice — by the proxy adapter (`llm-proxy/openai.ts`) and by `@earendil-works/pi-ai` (`api/openai-completions.js`, used by every platform-side run). **The two must agree, or identical consumption costs a different amount depending on where the run executed.** The openai-compatible formula (pi-ai's, mirrored exactly by the adapter):

```
cacheRead      = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? 0
cacheWrite     = prompt_tokens_details.cache_write_tokens ?? 0
input          = max(0, prompt_tokens − cacheRead − cacheWrite)
```

`prompt_tokens` is the TOTAL prompt in every dialect (OpenAI `cached_tokens ⊂ prompt_tokens`; DeepSeek `prompt_tokens = hit + miss`), so both cache buckets are carved back out of `input`. `cached_tokens` is the cache-READ count and nothing else: OpenAI neither documents nor emits `cache_write_tokens`, and the OpenRouter-compatible providers that do emit it report it as a **separate** count rather than folding it into `cached_tokens` ([OpenRouter's own provider](https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409), [ds4](https://github.com/antirez/ds4/pull/29)). Subtracting writes from `cached_tokens` therefore under-reports a spec-compliant provider, which is why pi-ai stopped doing it in 0.84 and the adapter follows. Anthropic's wire fields are already disjoint and map 1:1. Parity is enforced by `apps/api/test/unit/llm-proxy-usage-parity.test.ts`, which also fails if the installed pi-ai stops matching the transcribed formula. The layer above — the COST formula rather than the bucket normalisation — is pinned the same way by `apps/api/test/unit/runner-cost-parity.test.ts`: since the platform now prices the runner row itself, that file transcribes pi-ai's `calculateCost` and fails if the server's number stops matching what the container reports. It also asserts the two preconditions that let the transcription drop pi-ai's tier and 1h-cache-write branches (`ModelCost` cannot express volume tiers; the platform never sets `PI_CACHE_RETENTION=long`) — turn either on and the two formulas genuinely diverge.

Every count is floored at zero at the adapter boundary (`helpers.tokenCount`, and the same clamp in `recordChatUsage`): a negative count would produce a negative `cost_usd` that SUBTRACTS from the run's cost and from the corresponding debit. That application-side floor is backed by two DB constraints — `llm_usage_cost_usd_non_negative` and `runs_cost_non_negative` (migration `0029`) — so a write path that bypasses `recordLlmUsage` fails loudly instead of silently crediting an org.

Both constraints validate pre-existing rows when they are added. On an instance carrying a historical negative row the boot migration aborts, by design: a negative cost is a billing error that must surface at deploy time rather than keep subtracting. Check before deploying with `SELECT count(*) FROM llm_usage WHERE cost_usd < 0;` and `SELECT count(*) FROM runs WHERE cost < 0;` — both must return 0.

## Pricing provenance — a `0` says which kind of zero it is

The formula above is permissive on purpose: `computeTokenCost` returns `0` for an absent `cost`, and defaults both cache rates to `0`. That is correct arithmetic, but it made `cost_usd = 0` unattributable — a genuinely free subscription-backed call, a model the platform failed to price, and a call whose cached fraction was priced at zero were the same row.

`llm_usage.pricing_status` records which one it is. `classifyTokenPricing` (`@appstrate/afps-runtime/runner`, next to the formula) is the only place the rules live:

- **`unpriced`** — no rates at all (`ResolvedModel.cost == null`). `resolveCatalogDefaults` returns `{}` on any catalog miss (unmapped provider, unknown model id, an entry LiteLLM dropped for lacking pricing), and `POST /api/models` does not require the id to be in the catalog — so this is reachable, not theoretical. The `0` is an absence of pricing.
- **`partial`** — the model had rates, but a bucket that carried tokens had none: `cost.cacheRead` absent while `cache_read_input_tokens > 0`. Those tokens were already carved out of `input` by the normalisation above, so they are billed in no bucket at all. The figure is a floor. A missing `cacheWrite` rate deliberately does NOT trigger this — several vendors bill no write premium, and vendored coverage is so thin (5 of 89 openai entries) that flagging it would mark nearly everything `partial`.
- **`priced`** — every bucket that carried tokens had a rate.
- **`NULL`** — no claim. Rows written before the column existed (never backfilled — inventing `priced` would be the same false confidence), and the runner row of a run that resolved no platform model.

All three producers stamp it through `apps/api/src/services/pricing-provenance.ts`, which classifies and warns once per `(org, model, status)` per process. On the runner path the status and the cost are derived from ONE set of inputs in one function (`resolveRunnerCost`), which is what keeps them from disagreeing: the same `modelCostSchema`-narrowed `runs.model_cost` both prices the row and classifies it — a malformed snapshot yields `unpriced` AND `0`, never a `NaN` priced as fact. A run whose `model_source` is NULL is a remote-origin run that resolved no platform model; the same short-circuit governs both halves — its status is left NULL rather than `unpriced` (its inference is accounted elsewhere, typically as proxy rows carrying their own status), and its cost is the runner's reported figure passed through, because there are no server-side rates to recompute with.

That single-input rule also fixes what the degenerate-event skip in `writeRunnerLedgerRow` keys on: the input the row's cost is DERIVED from. A platform run needs a usage snapshot (a cost-only event would recompute to `0` and mint an all-zero row pinning nothing); a remote-origin run needs only the reported cost.

`computeRunSpend` rolls the rows up worst-of — any `unpriced` ⟹ `unpriced`, else any `partial` ⟹ `partial` — over the SAME rows it sums, and `finalizeRun` caches that on `runs.cost_pricing_status` beside `runs.cost`. The UI withholds the amount for an `unpriced` run rather than rendering `$0.0000`, and marks a `partial` one as a floor.

Separating the causes is now one query:

```sql
SELECT pricing_status, count(*), sum(cost_usd)
FROM llm_usage
WHERE cost_usd = 0 AND (input_tokens > 0 OR output_tokens > 0)
GROUP BY 1;
```

Two zeros that this status does NOT explain, by design: a subscription-backed run (`@appstrate/module-codex`, `@appstrate/module-claude-code`) resolves through `catalogProviderId` and is therefore `priced` at imputed public API rates even though the user pays a flat subscription — that imputation is deliberate; and an unparseable-usage 2xx keeps its own separate marker on `request_id` (see below), since a parse gap and a pricing gap are different failures.

## Every paid call reaches the ledger

Usage reporting is opt-in on the openai-compatible wire, so the adapter forces it (`LlmProxyAdapter.forceUsageReporting` → `stream_options.include_usage`) on **every** preset it forwards, system or org-owned — billing must not depend on the caller SDK setting a flag. The decision lives on the adapter (the protocol registry), never on an `apiShape` check in the core: adding a fifth API shape means implementing the hook, not editing `core.ts`.

When usage still cannot be parsed from a **2xx** reply (interrupted SSE tap, non-JSON body, a provider that ignored the flag), the call is recorded as an **accountable zero row**: zero tokens, zero cost, `request_id` prefixed `usage-unparsed:` (`SELECT … WHERE request_id LIKE 'usage-unparsed:%'` lists them). The provider was paid; recording nothing made the call invisible to both `runs.cost` and billing, with no way to even count the blind spot. Upstream **errors** (non-2xx) remain the only un-metered branch — no tokens were produced.

## The runner row: cumulative, monotone, and immutable once settled

There is **at most one** `source="runner"` row per run (partial unique index `uq_llm_usage_runner_run_id`). Every `appstrate.metric` event upserts it with the run's running total, so the row only ever advances: a strictly higher `cost_usd` wins, or an equal cost with a strictly higher token total (which is what keeps a zero-rate model's token columns climbing). An exact duplicate is a no-op that emits nothing.

Three rules protect it:

- **Terminal ledger barrier** — `finalizeRun` writes the terminal snapshot with `required: true` **before** the CAS that settles the run, on _every_ path and **regardless of `result.cost`**. Platform-synthesised terminals (stall watchdog, boot orphan sweep, container crash/timeout/cancel) build an empty `RunResult` that never carries `cost`; gating the barrier on `cost > 0` left exactly those runs settling with no barrier. `required` propagates a write failure, so the run stays open and finalize is retried rather than settling on a snapshot that is not durable. A run that consumed nothing (no tokens, no cost) has no accounting fact to pin and mints no row.
- **Post-settlement immutability** — the upsert refuses to mutate a row whose run already reached a terminal status (same predicate as `settledSql`, so the two cannot drift). Once settled, a billing cursor may claim the row by its serial `id`, exactly once, and never revisit it; a later UPDATE would raise a total nobody re-reads — silent under-billing. A refused snapshot is logged (`llm_usage: refused a runner snapshot on an already-settled run`) with the stored and refused totals. The structurally lossless alternative — inserting the delta as a NEW row with a fresh, sweepable id — is blocked by the single-row unique index and would need a migration.
- **No durable retry for runner rows** — a failed runner write PROPAGATES instead of being enqueued (`llm-usage-retry.ts`). An asynchronous replay could only land after the run settled, where the rule above refuses it. Propagation is also the correct recovery for a cumulative producer: on the metric path it rolls back the ingestion transaction (the sequence is not advanced, the runner re-POSTs, and its next cumulative snapshot supersedes the lost one), and at finalize it keeps the run unsettled. **Proxy rows keep the queue** — each is an immutable per-call fact that receives a fresh serial id when it lands, so a late replay is still swept and billed.

When a run dies **without** a terminal `result.usage` (watchdog kill, container crash), finalize preserves the last-known `runs.tokenUsage` snapshot the metric side channel wrote instead of zeroing it; only **success** terminals treat an absent `usage` as explicit zero (feeding the zero-token liveness heuristic).

## Read paths — the runner mirror is excluded at READ time

A `source="runner"` row is **always** written for a run that consumed tokens; it is **never** conditionally skipped because proxy rows exist. Double-counting is avoided at **read** time, by the single shared predicate `notRunnerMirrorSql` (`state/runs.ts`):

> a `source='runner'` row with `credential_source IS NULL` is a **mirror** — and therefore not a spend fact — when the same run also has `source='proxy'` rows.

A remote-origin run whose inference flows through the system llm-proxy carries BOTH per-call proxy rows (each with `credential_source` stamped) AND the runner's NULL-`credential_source` cumulative mirror (a remote run resolves no platform model, so `runs.model_source` is NULL). A platform run's runner row carries a non-NULL `credential_source` and stays authoritative; a remote run with ONLY a runner row keeps it; a detached row (`run_id IS NULL`) is never a mirror.

The predicate is applied by **all three** ledger reads — `computeRunSpend`, `listLlmUsage` (`PlatformServices.usage.list`) and `getSettledFrontierId` (`.settledFrontier`) — so a metering consumer that applies no filter of its own can no longer double-count a remote run. Skipping those ids is safe for the cursor: a batch is the next `limit` VISIBLE rows after `afterId`, so an empty batch still means "caught up", and an in-flight remote run's invisible mirror no longer pins the frontier.

## Settlement (what a cursor consumer may bill)

`settledSql` (`state/runs.ts`): a row is settled when `source <> 'runner'` (proxy/chat rows are immutable at insert) **or** its run reached a terminal status **or** its run row is gone. The last branch is live, not defensive: a runner row is DETACHED to `run_id = NULL` when its run is deleted (FK `ON DELETE SET NULL`), and a detached row can no longer grow. A consumer processes settled rows only and never advances its watermark past the first unsettled row.

**Ledger detach semantics (context deletion)**: an `llm_usage` row is an org-level accounting fact, billed after the fact by a cursor consumer (the `cloud/` module sweeps `services.usage.list` on a periodic tick, default 300s). A row can lose its **context** but never its **existence** while it may still be unswept. The context FKs are therefore `ON DELETE SET NULL`: deleting a run nulls `llm_usage.run_id`; deleting a chat session nulls `chat_session_id`. The row stays on the org's ledger with `org_id` and `credential_source` intact. The composite tenant-integrity FKs (`(run_id, org_id) → runs`, `(chat_session_id, org_id) → chat_sessions`) use the PG15+ column-list form `ON DELETE SET NULL (context_col)` so only the context column is nulled and the NOT-NULL `org_id` survives — hand-written in migration `0028_detach_llm_usage_context.sql` (Drizzle cannot express the column list). **Org deletion still cascades** the whole ledger (`org_id` FK) — total teardown of a deleted tenant is accepted. This closes a billing-evasion loop where deleting a terminal run before the sweep erased its not-yet-billed rows.

`orgId` is mandatory on `computeRunSpend`: `llm_usage.run_id` is caller-suppliable on the proxy path (`X-Run-Id`), so the aggregate must be structurally inseparable from the tenant (CRIT-07). The composite FK enforces the same invariant at the DB level for new rows.

## Known trade-offs (deferred)

- **Float precision**: `runs.cost`, `llm_usage.cost_usd` and `credential_proxy_usage.cost_usd` are `doublePrecision` (IEEE-754). Summing many sub-cent per-call costs accumulates rounding drift, so `runs.cost` can disagree with a re-summation by sub-cent amounts — relevant because `cloud/` bills off this data. Migrating to `numeric` is the correct fix but is a **cross-repo change**: `postgres.js` returns `numeric` as a **string**, so every read site (here + the private `cloud/` module) must parse it, in lockstep.
- **Lossless late runner snapshot**: dropping the single-row unique index and inserting post-settlement deltas as new rows would bill them instead of refusing them (see _Post-settlement immutability_).
- **`source` enum**: a third value (e.g. `chat`) would remove the labelling inaccuracy of the in-process chat producer.
