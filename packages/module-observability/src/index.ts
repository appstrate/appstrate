// SPDX-License-Identifier: Apache-2.0

/**
 * Observability module — OpenTelemetry provider for the core telemetry façade
 * (`@appstrate/core/telemetry`).
 *
 * The platform core instruments its business seams (run pipeline, container
 * spawn, LLM proxy, HTTP server spans) through a provider-agnostic façade and
 * carries ZERO OpenTelemetry footprint: no OTel imports, no SDK dependencies,
 * no `OTEL_*` env vars in the core schema. This module supplies the actual
 * OTel implementation:
 *
 *   - `init()` bootstraps the SDK ({@link initObservability} — fail-open, a
 *     misconfiguration can never crash boot) and installs a
 *     {@link TelemetryProvider} into the façade. Init runs after the Hono app
 *     is wired but before the first request, so spans/metrics cover every
 *     request.
 *   - The HTTP SERVER-span middleware is contributed via the provider's
 *     `httpMiddleware` slot — the core global telemetry middleware delegates
 *     to it per-request (modules cannot register `app.use("*")` themselves).
 *   - Flush-at-shutdown stays core-driven: the platform shutdown sequence
 *     calls the façade's `shutdownTelemetry()` at the documented invariant
 *     point (after in-flight drain + worker shutdown, before DB/Redis close).
 *     This module therefore declares NO `shutdown()` hook — module shutdown
 *     runs too early in that sequence and would double-flush.
 *
 * Layered opt-in:
 *   1. Load the module: append `@appstrate/module-observability` to `MODULES`.
 *   2. Enable export: set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_ENABLED=true`).
 * With the module loaded but no OTel env, everything stays a true no-op (the
 * SDK is dynamically imported only on the enabled path). Without the module,
 * the façade itself is the no-op — zero SDK load, zero allocation.
 *
 * Design rationale (bounded cardinality, trust gate, no auto-instrumentation
 * under Bun): `docs/architecture/OBSERVABILITY.md`.
 */

import type { AppstrateModule } from "@appstrate/core/module";
import { installTelemetryProvider } from "@appstrate/core/telemetry";
import { initObservability } from "./otel.ts";
import { createTelemetryProvider } from "./provider.ts";

const observabilityModule: AppstrateModule = {
  manifest: {
    id: "observability",
    name: "OpenTelemetry Observability",
    version: "1.0.0",
  },

  async init(ctx) {
    await initObservability({ logger: ctx.services.logger });
    installTelemetryProvider(createTelemetryProvider({ clientIp: ctx.services.http.clientIp }));
  },
};

export default observabilityModule;
