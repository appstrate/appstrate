# Observability (OpenTelemetry)

Production observability for the platform API, built on **OpenTelemetry** with
**OTLP/HTTP** export. Addresses issue #616 item 1.

> **Disabled by default — twice over.** The OTel implementation lives in the
> opt-in workspace module `@appstrate/module-observability`
> (`packages/module-observability/`), not in the core API. Without the module
> in `MODULES`, core's provider-agnostic telemetry façade is itself the no-op —
> zero SDK code is loaded (the 9 `@opentelemetry/*` deps belong to the module's
> `package.json`, not `apps/api`). With the module loaded but no collector
> configured, the bootstrap is still a complete no-op — zero per-request/per-run
> overhead and zero behavior change; the heavy SDK packages are dynamically
> imported only on the enabled path. OSS / self-hosted deployments that don't
> run a collector pay nothing.

## Enabling

Telemetry is a **two-step, layered opt-in**:

1. **Load the module** — append `@appstrate/module-observability` to `MODULES`
   (it is NOT in the default set — same opt-in posture as
   `@appstrate/module-codex` / `@appstrate/module-claude-code`).
2. **Point it at a collector** — telemetry turns on when **either** is true:
   - `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the common case), or
   - `OTEL_ENABLED=true` (uses the OTLP default endpoint `http://localhost:4318`).

Both steps are required. With the module loaded but no OTel env, everything
stays a no-op; without the module, the env vars are inert.

> **Migration note.** Deployments that enabled telemetry before the module
> split (env vars alone used to be sufficient) MUST add
> `@appstrate/module-observability` to `MODULES` — otherwise telemetry
> silently stays off.

| Variable                      | Default         | Notes                                                            |
| ----------------------------- | --------------- | ---------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —               | Base OTLP/HTTP endpoint; signal path (`/v1/traces`) appended.    |
| `OTEL_ENABLED`                | `false`         | Force-enable without an explicit endpoint.                       |
| `OTEL_SERVICE_NAME`           | `appstrate-api` | `service.name` resource attribute.                               |
| `OTEL_TRUST_INCOMING_TRACE`   | `false`         | Trust inbound `traceparent` for span parenting (security — §C3). |

The four `OTEL_*` vars above are **module-owned**: they are read directly from
`process.env` by the module (`packages/module-observability/src/env.ts`) with
the platform's usual parse semantics (`"true"`/`"1"` case-insensitive for
booleans; an empty endpoint counts as unset) — they are no longer part of the
`@appstrate/env` Zod schema, and are annotated as module vars in `docs/ENV.md`.

The metric export cadence is fixed at 60s (no custom knob).

The exporters also honor the standard OTLP env vars directly
(`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …), so the setup is
**collector-agnostic** — any OTLP/HTTP backend works (OpenTelemetry Collector,
Grafana Alloy, Honeycomb, Datadog OTLP intake, …).

Example:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=appstrate-api
```

### Docker self-hosting

Compose does **not** auto-forward host env into containers — only vars listed
under a service's `environment:` reach the process (there is no `env_file:`).
The OTel vars are wired as **passthroughs** in the `appstrate` service of every
self-hosting compose file (`docker-compose.yml`, `examples/self-hosting/*.yml`):

```yaml
# ── Observability (OpenTelemetry, optional) ──
- OTEL_ENABLED
- OTEL_EXPORTER_OTLP_ENDPOINT
- OTEL_SERVICE_NAME
- OTEL_TRUST_INCOMING_TRACE
- OTEL_EXPORTER_OTLP_HEADERS
- OTEL_EXPORTER_OTLP_PROTOCOL
```

So setting any of them in your `.env` is enough — Compose substitutes the host
value into the container, and an unset var is simply absent (bare passthrough,
no YAML default to duplicate — the module applies its own defaults). Don't
forget step 1: the container's `MODULES` must include
`@appstrate/module-observability` too. Running the API directly on the host
(`bun run dev`) reads `.env` natively, no wiring needed.

## Architecture

### Façade / provider split

Core never speaks OTel. Every instrumented seam goes through the
provider-agnostic façade `@appstrate/core/telemetry`
(`packages/core/src/telemetry.ts`) — `runWithSpan`, `currentTraceparent`, the
metric recorders, `telemetryHttpMiddleware`, `shutdownTelemetry` — which is a
true no-op until a provider is installed via `installTelemetryProvider()`. The
module installs the OTel adapter (`packages/module-observability/src/provider.ts`)
at `init()`. Core keeps exactly two thin generic points: a global `app.use("*")`
delegator (`apps/api/src/middleware/telemetry.ts`) that resolves the provider's
`httpMiddleware` slot per request (pure pass-through when none is installed),
and the core-driven flush — `shutdownTelemetry()` at the invariant flush point
in `apps/api/src/lib/shutdown.ts` (the module declares no `shutdown()` hook).
This keeps OTel vocabulary, SDK code, and dependencies entirely out of core
while the instrumentation points, span/metric semantics, and shutdown ordering
stay where they always were.

- **Bootstrap**: `packages/module-observability/src/otel.ts` — run at module
  `init()` during boot, before the server starts (so the lazily-imported SDK is
  wired before the first request), and defensive: a misconfiguration disables
  telemetry rather than crashing boot.
- **SERVER-span middleware**: lives in
  `packages/module-observability/src/middleware.ts`, contributed through the
  provider's `httpMiddleware` slot. It tags `client.address` via
  `services.http.clientIp(c)` — the platform's TRUST_PROXY-honoring client-IP
  resolver, injected through `PlatformServices` so the module never imports
  from `apps/api`.
- **Single AsyncLocalStorage**: spans do **not** fork a second trace store. The
  `runWithSpan` helper bridges the active OTel span's `SpanContext` into the
  existing logger trace context (`packages/core/src/logger.ts`), so **logs and
  spans share the same `trace_id`** automatically (OTel log-correlation
  conventions: `trace_id` / `span_id` / `trace_flags` on every line).
- **Reuses the existing traceparent seam**: inbound W3C `traceparent` headers are
  parsed with the same `parseTraceparent` the request-id middleware and the
  runtime event sink already use. The container is handed the active span as its
  parent (`apps/api/src/services/run-launcher/pi.ts`), so the whole
  **API → run → container** path is one trace. The trust gate
  (`OTEL_TRUST_INCOMING_TRACE`, default off — §C3) is applied at **both** the
  SERVER span **and** the run-execution tree: routes seed the run trace via
  `runTraceparent(c)`, which adopts the inbound header only when trusted and
  otherwise falls back to the in-process SERVER span (`currentTraceparent()`).
  So with trust off the run spans stay in **this** process's trace rather than an
  unverified caller-supplied one.
- **Shutdown**: spans + metrics are force-flushed during graceful shutdown —
  core-driven via the façade's `shutdownTelemetry()` at the same flush site as
  before (`apps/api/src/lib/shutdown.ts`).

## What's instrumented

### Spans

| Span                      | Where                                                                           | Notes                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<METHOD> <route>`        | module `httpMiddleware` (HTTP `SERVER`), delegated by `middleware/telemetry.ts` | Named with the matched route template (`http.route`), resolved AFTER the chain runs. Parented from inbound `traceparent` only when `OTEL_TRUST_INCOMING_TRACE` is on (§C3). |
| `appstrate.run.execute`   | `run-launcher/execute-background.ts`                                            | Run pipeline; parented from the launching trace.                                                                                                                            |
| `appstrate.run.container` | `run-launcher/pi.ts`                                                            | Container boundary/sidecar/agent/wait lifecycle. Forwards itself as the container's parent.                                                                                 |
| `appstrate.run.finalize`  | `run-event-ingestion.ts` (`finalizeRun`)                                        | CAS-guarded terminal convergence.                                                                                                                                           |

SERVER spans carry the OTel HTTP semconv request attributes:
`http.request.method`, `url.path`, `url.scheme` (required), `server.address`
(the Host the client targeted) and `client.address` (the resolved client IP,
honoring `TRUST_PROXY`; omitted when unresolvable) — plus `http.route` /
`http.response.status_code` after the chain runs. `network.protocol.version` is
deliberately **not** emitted: Bun/Hono expose the request as a fetch `Request`,
which carries no negotiated HTTP version, and semconv forbids guessing. On a
5xx the span status flips to ERROR and `error.type` is set (semconv
Conditionally Required): the escaped exception's class name when `app.onError`
caught a throw, else the status code as a string.

For unmatched requests (404) no low-cardinality template resolves: per OTel HTTP
semconv the span name is the **method alone** (`GET`) — never the raw path,
which would let a scanner spraying distinct paths explode the span-name
cardinality. The raw path is still preserved in the `url.path` attribute, and
`http.route` is **omitted**. SSE / streaming responses carry
`appstrate.response.streaming=true` — their span duration is **time-to-first-byte**
(the span ends when the handler returns its streaming `Response`), not the
stream lifetime (§C2).

### Metrics (SLIs)

Durations are recorded in **seconds** (`unit: "s"`, OTel semconv); the unit is
not embedded in the metric name (OTel naming guidance). Counters omit a `_total`
suffix — the Prometheus exporter appends it on export.

**Histogram buckets are per-instrument.** The SDK's DEFAULT explicit buckets
(`[0, 5, 10, 25, …, 10000]`) suit `appstrate.run.duration` (seconds-to-minutes)
but would collapse every sub-5s value into the single `(0, 5]` bucket — useless
for the fast instruments. So `container_spawn` and `llm.latency` set their own
sub-second-aware boundaries via the OTel `advice.explicitBucketBoundaries` hint
(read by the default histogram aggregation; `@opentelemetry/api ≥ 1.7`):

| Histogram                       | Boundaries (s)                                   | Range targeted    |
| ------------------------------- | ------------------------------------------------ | ----------------- |
| `appstrate.run.duration`        | SDK default `[0, 5, 10, 25, …, 10000]`           | seconds → minutes |
| `appstrate.run.container_spawn` | `[0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30]` | ~0.1–2s provision |
| `appstrate.llm.latency`         | `[0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]`    | ~0.3–5s upstream  |

| Metric                            | Type             | Tags                                                             | Source                                     |
| --------------------------------- | ---------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `appstrate.run.duration`          | histogram (s)    | `status`                                                         | `finalizeRun` (CAS winner, exactly once)   |
| `appstrate.run.terminal`          | counter          | `status`, `error_code`                                           | `finalizeRun` — failure-rate source        |
| `appstrate.run.container_spawn`   | histogram (s)    | `sidecar`, `error.type` (failure)                                | `runPlatformContainer` provisioning time   |
| `appstrate.scheduler.queue_depth` | observable gauge | —                                                                | BullMQ / local queue `count()`             |
| `appstrate.llm.latency`           | histogram (s)    | `api_shape`, `http.response.status_code`, `error.type` (failure) | platform LLM proxy (`routes/llm-proxy.ts`) |

The `error_code` label on `appstrate.run.terminal` is clamped to a bounded
allowlist so a runner-controlled string can never explode metric cardinality:
`timeout`, `manifest_invalid`, `provider_unauthorized` — any other code maps to
`other`, and an absent code maps to `none`.

`appstrate.run.container_spawn` covers both outcomes from one histogram (OTel
[Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)):
a successful provision carries **no** `error.type` (so clean cold-start latency
is filterable), while a failed one is tagged with the phase that failed —
`boundary` (isolation-boundary create) or `workload` (sidecar/agent spawn),
clamped to that allowlist (`other` otherwise). A `waitForWorkload` failure is an
**execution** failure, not a spawn failure, and emits no spawn data point.

`appstrate.llm.latency` follows the same Recording-errors pattern with OTel HTTP
semconv attribute names: `http.response.status_code` carries the upstream status
when a response was received, and `error.type` is present on **failure only** —
the status code as a string for 4xx/5xx upstream replies, or the semconv
fallback `_OTHER` when the call failed before producing any response (transport
error). Success points carry no `error.type`, so clean latency and error rate
both derive from the one histogram. (Earlier revisions used non-semconv
`outcome`/`status_code` labels — renamed; update any dashboards built against
them.)

## Service-level indicators (SLIs)

- **Run latency** — `appstrate.run.duration` (p50/p95/p99 by status).
- **Run failure rate** — `appstrate.run.terminal` filtered by
  `status="failed"|"timeout"` over total.
- **Container cold-start** — `appstrate.run.container_spawn`.
- **Scheduler backlog** — `appstrate.scheduler.queue_depth`.
- **LLM proxy latency** — `appstrate.llm.latency`.
- **DB health latency** — already surfaced by `GET /health` (`checks.database.latency_ms`).

## Limitations / follow-ups

- **Sidecar-side LLM latency.** The LLM-latency histogram is recorded at the
  in-process platform proxy seam (`/api/llm-proxy`). The credential-isolating
  **sidecar** runs in a separate per-run container on an isolated network and
  would need its own OTel bootstrap plus collector reachability to export from
  there — tracked as a follow-up. The container's outbound HTTP already carries
  the forwarded `traceparent`, so a future sidecar exporter would slot into the
  same trace.
- **No auto-instrumentation.** Under Bun the Node auto-instrumentation
  module-patching is unreliable, so instrumentation is explicit at the
  orchestration seams (thin `runWithSpan` wrappers + metric recorders). This is
  intentional and keeps the no-op-when-disabled guarantee exact.

## Design decisions

- **§C2 — Streaming span duration is time-to-first-byte.** The server-span
  middleware ends the SERVER span when the handler RETURNS its `Response`. For
  long-lived SSE streams (`/api/llm-proxy`, run-events) that is the moment the
  headers flush, not when the stream closes — so the span measures
  time-to-first-byte, not stream lifetime. Rather than hook every stream's
  finalization (invasive, and Hono's `streamSSE` owns the lifecycle), these
  spans are tagged `appstrate.response.streaming=true` so the duration is never
  silently mistaken for a request-latency SLI. A dedicated stream-lifetime span
  is a possible follow-up.
- **§C3 — Inbound `traceparent` is untrusted by default.** The server span is
  parented from the caller-supplied `traceparent` header **only** when
  `OTEL_TRUST_INCOMING_TRACE=true`. On a public-facing API an unauthenticated
  caller could otherwise inject arbitrary trace context (trace spoofing /
  log-correlation injection). With the flag off a fresh root span is started —
  a SERVER span is still emitted, just not parented from the unverified header.
  Enable the flag only when the platform sits behind a trusted gateway that
  controls `traceparent` for external callers. (The request-id middleware's
  pre-existing echo of a _validated_ inbound header to the response is
  observability cosmetics, not propagation, and is unchanged.)

  The gate covers the **run-execution trace tree too**, not just the SERVER
  span. Previously the run path (`runs.ts` → pipeline → `executeAgentInBackground`
  → container) seeded itself from the raw inbound header (`c.get("traceparent")`)
  — a **cross-process** link that bypassed the trust check, so an attacker could
  still splice the run + container spans into a chosen `trace_id`. The run routes
  now resolve the seed via `runTraceparent(c)`: inbound header when trusted,
  otherwise the in-process SERVER span via `currentTraceparent()` (or a fresh
  root when telemetry is off). With trust off the run trace is genuinely
  in-process, eliminating both the spoof vector and the SERVER-vs-run trace
  fragmentation.
