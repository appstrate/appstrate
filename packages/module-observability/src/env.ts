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

/** `"true"`/`"1"` (case-insensitive) → true, anything else → false — same
 * parse semantics as `@appstrate/env`'s `boolEnv`. */
function boolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  return raw.toLowerCase() === "true" || raw === "1";
}

export interface OtelEnv {
  /** OTEL_ENABLED=true OR a non-empty OTEL_EXPORTER_OTLP_ENDPOINT. */
  enabled: boolean;
  /** Base OTLP collector endpoint; empty string reads as unset (compose `${VAR:-}` pattern). */
  endpoint: string | undefined;
  /** `service.name` resource attribute. */
  serviceName: string;
  /**
   * Trust the inbound W3C `traceparent` header for SERVER-span parenting.
   * Default OFF: a public-facing API must not let an unauthenticated caller
   * splice the server span into an attacker-chosen trace. When off, a fresh
   * root span is started — a SERVER span is still emitted, just not parented
   * from the header. Enable only behind a trusted gateway that strips/sets
   * `traceparent` for external callers.
   */
  trustIncomingTrace: boolean;
}

export function readOtelEnv(): OtelEnv {
  const rawEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = rawEndpoint === "" ? undefined : rawEndpoint;
  return {
    enabled: boolEnv(process.env.OTEL_ENABLED, false) || endpoint !== undefined,
    endpoint,
    serviceName: process.env.OTEL_SERVICE_NAME || "appstrate-api",
    trustIncomingTrace: boolEnv(process.env.OTEL_TRUST_INCOMING_TRACE, false),
  };
}
