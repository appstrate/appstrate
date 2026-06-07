# Observability (OpenTelemetry)

Production observability for the platform API, built on **OpenTelemetry** with
**OTLP/HTTP** export. Addresses issue #616 item 1.

> **Disabled by default.** With no collector configured the OTel bootstrap is a
> complete no-op — zero per-request/per-run overhead and zero behavior change
> when disabled. The heavy SDK packages are dynamically imported only on the
> enabled path, so a disabled boot loads only the `@opentelemetry/api` no-op.
> OSS / self-hosted deployments that don't run a collector pay nothing.

## Enabling

Telemetry turns on when **either** is true:

- `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the common case), or
- `OTEL_ENABLED=true` (uses the OTLP default endpoint `http://localhost:4318`).

| Variable                      | Default         | Notes                                                            |
| ----------------------------- | --------------- | ---------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —               | Base OTLP/HTTP endpoint; signal path (`/v1/traces`) appended.    |
| `OTEL_ENABLED`                | `false`         | Force-enable without an explicit endpoint.                       |
| `OTEL_SERVICE_NAME`           | `appstrate-api` | `service.name` resource attribute.                               |
| `OTEL_TRUST_INCOMING_TRACE`   | `false`         | Trust inbound `traceparent` for span parenting (security — §C3). |

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

## Architecture

- **Bootstrap**: `apps/api/src/observability/` — `initObservability()` is
  `await`ed once in `apps/api/src/index.ts` before the server starts (so the
  lazily-imported SDK is wired before the first request), and is defensive: a
  misconfiguration disables telemetry rather than crashing boot.
- **Single AsyncLocalStorage**: spans do **not** fork a second trace store. The
  `runWithSpan` helper bridges the active OTel span's `SpanContext` into the
  existing logger trace context (`packages/core/src/logger.ts`), so **logs and
  spans share the same `trace_id`** automatically (OTel log-correlation
  conventions: `trace_id` / `span_id` / `trace_flags` on every line).
- **Reuses the existing traceparent seam**: inbound W3C `traceparent` headers are
  parsed with the same `parseTraceparent` the request-id middleware and the
  runtime event sink already use. The container is handed the active span as its
  parent (`apps/api/src/services/run-launcher/pi.ts`), so the whole
  **API → run → container** path is one trace. **Inbound** parenting from the
  request header is gated by `OTEL_TRUST_INCOMING_TRACE` (default off — §C3);
  the in-process API → run → container linkage is unaffected.
- **Shutdown**: spans + metrics are force-flushed during graceful shutdown
  (`apps/api/src/lib/shutdown.ts`).

## What's instrumented

### Spans

| Span                      | Where                                        | Notes                                                                                                                                                                       |
| ------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<METHOD> <route>`        | `observability()` middleware (HTTP `SERVER`) | Named with the matched route template (`http.route`), resolved AFTER the chain runs. Parented from inbound `traceparent` only when `OTEL_TRUST_INCOMING_TRACE` is on (§C3). |
| `appstrate.run.execute`   | `run-launcher/execute-background.ts`         | Run pipeline; parented from the launching trace.                                                                                                                            |
| `appstrate.run.container` | `run-launcher/pi.ts`                         | Container boundary/sidecar/agent/wait lifecycle. Forwards itself as the container's parent.                                                                                 |
| `appstrate.run.finalize`  | `run-event-ingestion.ts` (`finalizeRun`)     | CAS-guarded terminal convergence.                                                                                                                                           |

For unmatched requests (404) no template resolves: the span name falls back to
the raw `url.path` and the `http.route` attribute is **omitted** (it would be
high-cardinality). SSE / streaming responses carry
`appstrate.response.streaming=true` — their span duration is **time-to-first-byte**
(the span ends when the handler returns its streaming `Response`), not the
stream lifetime (§C2).

### Metrics (SLIs)

Durations are recorded in **seconds** (`unit: "s"`, OTel semconv) so typical
1s–minutes runs land inside the SDK's default histogram buckets (recording raw
ms overflowed every value into the `(10000, +inf)` bucket, breaking p50/p95/p99).
The unit is not embedded in the metric name (OTel naming guidance). Counters omit
a `_total` suffix — the Prometheus exporter appends it on export.

| Metric                            | Type             | Tags                                  | Source                                     |
| --------------------------------- | ---------------- | ------------------------------------- | ------------------------------------------ |
| `appstrate.run.duration`          | histogram (s)    | `status`                              | `finalizeRun` (CAS winner, exactly once)   |
| `appstrate.run.terminal`          | counter          | `status`, `error_code`                | `finalizeRun` — failure-rate source        |
| `appstrate.run.container_spawn`   | histogram (s)    | `sidecar`                             | `runPlatformContainer` provisioning time   |
| `appstrate.scheduler.queue_depth` | observable gauge | —                                     | BullMQ / local queue `count()`             |
| `appstrate.llm.latency`           | histogram (s)    | `api_shape`, `outcome`, `status_code` | platform LLM proxy (`routes/llm-proxy.ts`) |

The `error_code` label on `appstrate.run.terminal` is clamped to a bounded
allowlist so a runner-controlled string can never explode metric cardinality:
`timeout`, `manifest_invalid`, `provider_unauthorized` — any other code maps to
`other`, and an absent code maps to `none`.

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
