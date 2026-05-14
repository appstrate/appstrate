# `portkey` — built-in module

Phase 1 integration of the open-source [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) as Appstrate's LLM gateway. See issue [#437](https://github.com/appstrate/appstrate/issues/437) for the full epic.

## What it does

When `MODULES=portkey,…` is set, the module:

1. Spawns `@portkey-ai/gateway/build/start-server.js` as a Bun sub-process at `init()`, bound to `127.0.0.1:${PORTKEY_PORT}` (default `8787`).
2. Installs a `PortkeyRouter` on `apps/api/src/services/portkey-router.ts`.
3. The `run-launcher/pi.ts` consults the router at every run start. For API-key LLM configs, the sidecar's `/llm/*` reverse proxy is re-pointed at Portkey, and the inline `x-portkey-config` header carries `{ provider, api_key, custom_host?, retry }` so Portkey can route + retry + honor `Retry-After` without a Portkey-side credential store.
4. Pi SDK's internal retry is disabled (`MODEL_RETRY_ENABLED=false`) so the SDK and Portkey don't stack retries on 429.
5. Subscription-OAuth credentials (Codex, Claude Pro) **bypass Portkey entirely** — they keep using the sidecar's existing OAuth wireFormat path.

## Why a module (and not a default)

Phase 1 ships **opt-in**. The default `MODULES` list does NOT include `portkey`. Operators dogfood locally first, then we flip the default once the integration has been stable in prod. When the module is absent, `getPortkeyRouter()` returns `null` and the run launcher falls through to the legacy direct-upstream path — zero footprint.

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

## Open follow-ups (phase 2+, not in this module)

- Pricing catalog adoption (`Portkey-AI/models`) — replaces manual `org_models.cost` JSONB.
- Open model catalog UX — feature `Custom / Advanced` mode exposing Portkey's 1 600+ providers.
- Optional refinements: in-process Hono mount, semantic cache, multi-provider fallback chains.
- `apps/api/src/services/llm-proxy/*` (the runner-side direct-proxy used by `@appstrate/github-action`): currently bypasses Portkey. To re-route through the same gateway, a follow-up needs to inject `x-portkey-config` on those code paths.
