// SPDX-License-Identifier: Apache-2.0

/**
 * OTel env handling — local to this module. The platform env schema
 * (`@appstrate/env`) deliberately carries no `OTEL_*` vars: telemetry config
 * travels with the module that consumes it, so a deployment without the
 * module has zero OTel vocabulary in core. Misconfiguration here can never
 * crash boot — `initObservability` is fail-open by contract.
 *
 * Only the appstrate-specific vars are parsed here. The standard OTLP wire
 * vars (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …) are
 * read by the OTLP exporters directly from `process.env`, per OTel spec.
 */

import { z } from "zod";

/** `"true"`/`"1"` (case-insensitive) → true, anything else → false — same
 * parse semantics as `@appstrate/env`'s `boolEnv`. */
const boolEnv = z
  .string()
  .optional()
  .transform((raw) => raw?.toLowerCase() === "true" || raw === "1");

/** Empty string reads as unset (compose `${VAR:-}` pattern). */
const optionalString = z
  .string()
  .optional()
  .transform((raw) => raw || undefined);

export const otelEnvSchema = z.object({
  OTEL_ENABLED: boolEnv,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  /** `service.name` resource attribute. */
  OTEL_SERVICE_NAME: optionalString.transform((v) => v ?? "appstrate-api"),
  /**
   * Trust the inbound W3C `traceparent` header for SERVER-span parenting.
   * Default OFF: a public-facing API must not let an unauthenticated caller
   * splice the server span into an attacker-chosen trace. When off, a fresh
   * root span is started — a SERVER span is still emitted, just not parented
   * from the header. Enable only behind a trusted gateway that strips/sets
   * `traceparent` for external callers.
   */
  OTEL_TRUST_INCOMING_TRACE: boolEnv,
});

interface OtelEnv {
  /** OTEL_ENABLED=true OR a non-empty OTEL_EXPORTER_OTLP_ENDPOINT. */
  enabled: boolean;
  endpoint: string | undefined;
  serviceName: string;
  trustIncomingTrace: boolean;
}

export function readOtelEnv(source: NodeJS.ProcessEnv = process.env): OtelEnv {
  const env = otelEnvSchema.parse(source);
  return {
    enabled: env.OTEL_ENABLED || env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    trustIncomingTrace: env.OTEL_TRUST_INCOMING_TRACE,
  };
}
