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

| Variable                         | Default         | Notes                                                         |
| -------------------------------- | --------------- | ------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | —               | Base OTLP/HTTP endpoint; signal path (`/v1/traces`) appended. |
| `OTEL_ENABLED`                   | `false`         | Force-enable without an explicit endpoint.                    |
| `OTEL_SERVICE_NAME`              | `appstrate-api` | `service.name` resource attribute.                            |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `60000`         | Metric flush cadence (ms).                                    |

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
  **API → run → container** path is one trace.
- **Shutdown**: spans + metrics are force-flushed during graceful shutdown
  (`apps/api/src/lib/shutdown.ts`).

## What's instrumented

### Spans

| Span                      | Where                                        | Notes                                                                                       |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `<METHOD> <route>`        | `observability()` middleware (HTTP `SERVER`) | Parented from inbound `traceparent`.                                                        |
| `appstrate.run.execute`   | `run-launcher/execute-background.ts`         | Run pipeline; parented from the launching trace.                                            |
| `appstrate.run.container` | `run-launcher/pi.ts`                         | Container boundary/sidecar/agent/wait lifecycle. Forwards itself as the container's parent. |
| `appstrate.run.finalize`  | `run-event-ingestion.ts` (`finalizeRun`)     | CAS-guarded terminal convergence.                                                           |

### Metrics (SLIs)

All durations carry `unit: "ms"`; the unit is not embedded in the metric name
(OTel naming guidance). Counters omit a `_total` suffix — the Prometheus
exporter appends it on export.

| Metric                            | Type             | Tags                                  | Source                                     |
| --------------------------------- | ---------------- | ------------------------------------- | ------------------------------------------ |
| `appstrate.run.duration`          | histogram (ms)   | `status`                              | `finalizeRun` (CAS winner, exactly once)   |
| `appstrate.run.terminal`          | counter          | `status`, `error_code`                | `finalizeRun` — failure-rate source        |
| `appstrate.run.container_spawn`   | histogram (ms)   | `sidecar`                             | `runPlatformContainer` provisioning time   |
| `appstrate.scheduler.queue_depth` | observable gauge | —                                     | BullMQ / local queue `count()`             |
| `appstrate.llm.latency`           | histogram (ms)   | `api_shape`, `outcome`, `status_code` | platform LLM proxy (`routes/llm-proxy.ts`) |

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
