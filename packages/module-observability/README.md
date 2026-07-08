# @appstrate/module-observability

OpenTelemetry provider for the Appstrate platform's telemetry façade
(`@appstrate/core/telemetry`). Exports traces + metrics over OTLP/HTTP to any
compatible backend (OTel Collector, Grafana Alloy, Honeycomb, …).

The platform core instruments its business seams (run pipeline, container
spawn, LLM proxy, HTTP server spans) through a provider-agnostic no-op façade
and carries **zero OpenTelemetry footprint** — no OTel imports, no SDK
dependencies, no `OTEL_*` env vars in the core schema. This module supplies
the actual implementation: at `init()` it bootstraps the OTel SDK (fail-open —
a misconfiguration can never crash boot) and installs a `TelemetryProvider`
into the façade.

## Enabling (layered opt-in)

```sh
# 1. Load the module (not in the MODULES default set)
MODULES=oidc,webhooks,mcp,core-providers,@appstrate/module-chat,@appstrate/module-observability

# 2. Enable export — either is sufficient
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# OTEL_ENABLED=true   # force-enable onto the OTLP default endpoint
```

With the module loaded but no OTel env set, everything stays a true no-op —
the SDK is dynamically imported only on the enabled path. Without the module,
the core façade itself is the no-op: zero SDK load, zero allocation.

## Env vars (module-owned)

Read directly from `process.env` — deliberately **not** part of the
`@appstrate/env` core schema:

| Variable                      | Default         | Notes                                                            |
| ----------------------------- | --------------- | ---------------------------------------------------------------- |
| `OTEL_ENABLED`                | `false`         | Force-enable without an explicit endpoint                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —               | Base OTLP endpoint; setting it enables telemetry; `""` = unset   |
| `OTEL_SERVICE_NAME`           | `appstrate-api` | `service.name` resource attribute                                |
| `OTEL_TRUST_INCOMING_TRACE`   | `false`         | Trust inbound `traceparent` for span parenting (anti-spoof gate) |

Standard OTLP wire vars (`OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, …) are honored by the exporters directly.

## What it contributes

- **Spans** at the platform's business seams (`appstrate.run.*` trace tree,
  HTTP SERVER spans via the provider `httpMiddleware` slot — core's global
  telemetry middleware delegates per-request).
- **Metrics**: `appstrate.run.duration`, `appstrate.run.terminal`,
  `appstrate.run.container_spawn`, `appstrate.llm.latency`,
  `appstrate.process.anomaly`, `appstrate.scheduler.queue_depth` — all with
  bounded-cardinality labels.
- No tables, no routes, no permissions, no shutdown hook (flush stays
  core-driven at the documented invariant point in the shutdown sequence).

Design rationale (trust gate, cardinality clamps, no auto-instrumentation
under Bun): `docs/architecture/OBSERVABILITY.md`.
