# `portkey` — built-in module (**mandatory**)

Integration of the open-source [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) as Appstrate's LLM gateway. See issue [#437](https://github.com/appstrate/appstrate/issues/437) for the full epic.

`portkey` is a **required** built-in. The default `MODULES` env var includes it, and `boot.ts` aborts startup via `assertPortkeyRoutersInstalled()` if the slot is empty after `loadModules()`. To run without it, remove it from `MODULES` **and** be aware that every API-key LLM request will fail.

## What it does

The module:

1. Spawns `@portkey-ai/gateway/build/start-server.js` as a Bun sub-process at `init()`, bound to `127.0.0.1:${PORTKEY_PORT}` (default `8787`).
2. Installs **two** routers on `apps/api/src/services/portkey-router.ts`:
   - `setPortkeyRouter()` — sidecar-facing, base URL `http://host.docker.internal:<port>` (Docker bridge).
   - `setPortkeyInprocessRouter()` — apps/api-facing, base URL `http://127.0.0.1:<port>` (loopback).
     Both routers emit the same inline `x-portkey-config` payload — different baseUrl per consumer.
3. **Sidecar caller** (`run-launcher/pi.ts`): consults the sidecar router at every run start. For API-key LLM configs, the sidecar's `/llm/*` reverse proxy is re-pointed at Portkey, and the inline `x-portkey-config` header carries `{ provider, api_key, custom_host?, retry }` so Portkey can route + retry + honor `Retry-After` without a Portkey-side credential store.
4. **In-process caller** (`services/llm-proxy/*` — the runner-side proxy used by `@appstrate/github-action` and the CLI): consults the in-process router on every `/api/llm-proxy/*` call. Same `x-portkey-config` payload; the upstream URL is swapped to the local Portkey gateway. Cost tracking is unaffected — Portkey passes the upstream response (including SSE `usage` frame) verbatim, so the adapter-driven metering in `llm-proxy/core.ts` still applies.
5. Pi SDK's internal retry is disabled (`MODEL_RETRY_ENABLED=false`) on the sidecar path so the SDK and Portkey don't stack retries on 429. The in-process path never had a retry layer of its own — the gateway adds retry as new behavior here.
6. Subscription-OAuth credentials (Codex, Claude Pro) **bypass Portkey entirely** — they keep using the sidecar's existing OAuth wireFormat path.

### URL path convention

The routing baseUrl bakes the `/v1` segment per shape so the caller's relative path lands on Portkey's expected HTTP surface:

| `apiShape`                                                | Portkey baseUrl           | Caller path appended | Final URL                           |
| --------------------------------------------------------- | ------------------------- | -------------------- | ----------------------------------- |
| `openai-chat` / `openai-completions` / `openai-responses` | `http://<host>:<port>/v1` | `/chat/completions`  | `<host>:<port>/v1/chat/completions` |
| `mistral-conversations`                                   | `http://<host>:<port>/v1` | `/chat/completions`  | `<host>:<port>/v1/chat/completions` |
| `anthropic-messages`                                      | `http://<host>:<port>`    | `/v1/messages`       | `<host>:<port>/v1/messages`         |

Anthropic's SDK already includes `/v1` in the request path, so the baseUrl stays bare. OpenAI / Mistral SDKs append `/chat/completions` to a `/v1`-baked baseUrl. The path-prefix map is centralized in `config.ts:API_SHAPE_PORTKEY_PATH_PREFIX`.

## Subscription-OAuth bypass (explicit non-scope)

Personal-subscription OAuth providers — `@appstrate/module-codex` (ChatGPT/Codex), the external `@appstrate/module-claude-code` (Claude Pro/Max/Team), and any future flat-fee identity provider — **bypass Portkey entirely**. Reason: Portkey 1.15.2 OSS exposes no mechanism to register a custom provider with a non-standard auth wireFormat (verified by spike on the 471 KB bundle — no `customProviders` flag, no env, no plugin API). Forking Portkey to add three providers would create a long-tail maintenance burden disproportionate to the gain — these flows are flat-fee, so there's no per-request cost to attribute through the gateway anyway.

The bypass is implemented in the call sites, not here: `run-launcher/pi.ts` switches on `isOauthCredential` before consulting `getPortkeyRouter()`. The sidecar's existing OAuth wireFormat path remains the active route for these credentials.

## Cost tracking — why the vendored catalog stays

The OSS Portkey gateway does NOT compute price in USD. Static analysis of the 471 KB bundle: zero occurrences of `cost`/`price`/`pricing` and zero `x-portkey-cost-*` response headers. Token usage (`prompt_tokens`/`completion_tokens` / `input_tokens`/`output_tokens`) is passed through verbatim from upstream, but the multiplication by per-token price is a Portkey **Cloud** feature, not bundled in the open-source gateway.

Consequence: the vendored `apps/api/src/data/pricing/*.json` catalog and `services/pricing-catalog.ts` are the **only** source of cost truth platform-side. Refresh weekly via a CI script (planned — `scripts/refresh-pricing-catalog.ts`) that diffs against `Portkey-AI/models`.

## Shutdown ordering

The smoke tests (`/tmp/portkey-smoke/test3-lifecycle.ts`) confirmed Portkey does **not** drain in-flight streams on SIGTERM — it exits in ~1 s with all open responses cut. The platform handles this with the existing shutdown order in `apps/api/src/lib/shutdown.ts`:

1. Refuse new POSTs (`setShuttingDown`)
2. Stop the sidecar pool
3. `waitForInFlight(30s)` — drain run-tracker
4. `shutdownModules()` — module `shutdown()` SIGTERMs Portkey

Steps 3→4 guarantee Portkey is killed only after every in-flight run has either completed or been timed out. The module's `stopPortkey()` itself does `SIGTERM` → 3 s grace → `SIGKILL`.

## Telemetry

None to opt out of. Static analysis of the 471 KB build found zero telemetry SDKs (no posthog/mixpanel/datadog/sentry). The only `*.portkey.ai` URLs in the binary are:

- `api.portkey.ai/v1/execute-guardrails` — opt-in via `portkeyGuardrails` in the inline config (we never set it)
- `api.portkey.ai/v1/files/{id}/content` — only when `portkey` itself is the provider slug (we never set it)

## Files

| File           | Purpose                                                               |
| -------------- | --------------------------------------------------------------------- |
| `index.ts`     | `AppstrateModule` default export — wires init/shutdown/router.        |
| `lifecycle.ts` | Spawn / ready-detection / SIGTERM-then-SIGKILL of the sub-process.    |
| `config.ts`    | `apiShape` → Portkey provider mapping, builds the `x-portkey-config`. |
| `test/`        | Unit + integration tests, including a real Portkey spawn E2E.         |

## Open follow-ups

- ✅ **Phase 2 — pricing catalog** shipped. Vendored from [`Portkey-AI/models`](https://github.com/Portkey-AI/models) (MIT, weekly upstream refresh) under `apps/api/src/data/pricing/`. `apps/api/src/services/pricing-catalog.ts` exposes `lookupModelCost(apiShape, modelId)`. `org_models.cost` becomes an **override**: when set it wins, when null we fall back to the catalog. ~200 models across openai / anthropic / mistral-ai / google.
- ✅ **Phase 2.5 — Portkey mandatory** shipped. Module added to default `MODULES`, fail-fast at boot via `assertPortkeyRoutersInstalled()`, fallback branches removed from `run-launcher/pi.ts` and `llm-proxy/core.ts`. `accept-encoding: identity` injected on Portkey-routed proxy requests (works around Bun fetch ZlibError on Anthropic SSE — discovered in real-key smoke).
- **Phase 3 — open model catalog UX** (next) — featured/advanced split, drop hardcoded registry, migrate `providerId` enum → free-text.
- **Phase 4 — refinements** — semantic cache, multi-provider fallback chains, OTel metrics. (In-process mount blocked upstream — `@portkey-ai/gateway` doesn't export a mountable Hono app. Custom provider injection also blocked — would require fork; we keep the subscription-OAuth bypass instead.)
