// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter from the core telemetry façade contract (`@appstrate/core/telemetry`
 * — provider-agnostic, no OTel vocabulary) to this module's OpenTelemetry
 * implementation. All disabled-state guards live in `otel.ts` — when OTel is
 * not enabled every delegate below is already a no-op, so the provider can be
 * installed unconditionally at module init.
 */

import { SpanKind } from "@opentelemetry/api";
import type { Context } from "hono";
import type { TelemetryProvider, TelemetrySpanOptions } from "@appstrate/core/telemetry";
import { readOtelEnv } from "./env.ts";
import { observability } from "./middleware.ts";
import {
  runWithSpan,
  currentTraceparent,
  recordRunDuration,
  recordRunTerminal,
  recordContainerSpawn,
  recordLlmLatency,
  recordProcessAnomaly,
  recordStorageDeletionSweep,
  recordStorageDeletionResult,
  recordDocumentCreated,
  recordDocumentDeleted,
  recordDocumentQuotaRejection,
  recordDocumentPartialPublication,
  setQueueDepthProvider,
  shutdownObservability,
} from "./otel.ts";

export interface TelemetryProviderDeps {
  /** Platform client-IP resolver (`ctx.services.http.clientIp`). */
  clientIp: (c: Context) => string;
}

/** Map the façade's provider-agnostic span kind onto the OTel enum. */
function spanKind(kind: TelemetrySpanOptions["kind"]): SpanKind {
  return kind === "server" ? SpanKind.SERVER : SpanKind.INTERNAL;
}

export function createTelemetryProvider(deps: TelemetryProviderDeps): TelemetryProvider {
  // Env is validated + stable for the process lifetime — read the trust flag
  // once at construction (module init), same cadence as the middleware.
  const trustIncomingTrace = readOtelEnv().trustIncomingTrace;

  return {
    runWithSpan: (name, opts, fn) =>
      runWithSpan(
        name,
        { kind: spanKind(opts.kind), traceparent: opts.traceparent, attributes: opts.attributes },
        fn,
      ),
    currentTraceparent,
    trustsIncomingTrace: () => trustIncomingTrace,
    recordRunDuration,
    recordRunTerminal,
    recordContainerSpawn,
    recordLlmLatency,
    recordProcessAnomaly,
    recordStorageDeletionSweep,
    recordStorageDeletionResult,
    recordDocumentCreated,
    recordDocumentDeleted,
    recordDocumentQuotaRejection,
    recordDocumentPartialPublication,
    setQueueDepthSource: setQueueDepthProvider,
    httpMiddleware: observability({ clientIp: deps.clientIp }),
    shutdown: shutdownObservability,
  };
}
