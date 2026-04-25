// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * W3C Trace Context — `traceparent` header generation, parsing, and
 * validation.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 *
 * `traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}`
 *
 *   - `version`: 2 hex chars. Currently `00`.
 *   - `trace-id`: 32 hex chars (16 bytes). Identifies the distributed
 *     trace; constant across every span of a single run.
 *   - `parent-id`: 16 hex chars (8 bytes). Identifies the SPAN that the
 *     next service should treat as its parent — so the field is renamed
 *     per hop, hence the name "parent".
 *   - `trace-flags`: 2 hex chars. `00` (not sampled) or `01` (sampled).
 *
 * The runtime emits one `traceparent` per HTTP request to the ingestion
 * route. The trace-id is constant for the run; the parent-id (span-id)
 * is fresh on every request. Receivers (the platform API) parse the
 * header into a `req.traceparent` they can attach to logger context, and
 * — when they make their own outbound calls — generate a new span-id
 * downstream while preserving the trace-id.
 *
 * No OTel SDK. Pure W3C wire format. Sender: `HttpSink`. Receiver:
 * `requestId` middleware on the platform API.
 */

import { randomBytes } from "node:crypto";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const SUPPORTED_VERSION = "00";
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_PARENT_ID = "0".repeat(16);

export interface TraceContext {
  /** 32 hex chars. Constant across every span of a trace. */
  readonly traceId: string;
  /** 16 hex chars. Unique per span — refreshed on every outbound call. */
  readonly spanId: string;
  /** 2 hex chars. `00` (not sampled) or `01` (sampled). */
  readonly flags: string;
}

/**
 * Parse a `traceparent` header value. Returns `null` for malformed,
 * unsupported-version, or all-zero (forbidden) values per spec §3.2.
 *
 * The all-zero rejection matters: clients are required to discard a
 * traceparent whose trace-id or parent-id is all zeros, so accepting it
 * would silently propagate broken context across services.
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const match = TRACEPARENT_REGEX.exec(value.trim());
  if (!match) return null;
  // The regex has 4 capture groups all anchored to required hex spans, so
  // a successful match guarantees groups 1..4 are strings — assert to
  // keep the returned shape strictly typed.
  const version = match[1]!;
  const traceId = match[2]!;
  const spanId = match[3]!;
  const flags = match[4]!;
  if (version !== SUPPORTED_VERSION) return null;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_PARENT_ID) return null;
  return { traceId, spanId, flags };
}

/** Serialise a {@link TraceContext} into a wire-format `traceparent` value. */
export function formatTraceparent(ctx: TraceContext): string {
  return `${SUPPORTED_VERSION}-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

/**
 * Generate a fresh 16-byte (32 hex) trace-id. Uses CSPRNG so collisions
 * are vanishingly rare across processes. Caller owns the lifecycle —
 * one trace-id per run.
 */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Generate a fresh 8-byte (16 hex) span-id. One span-id per outbound
 * HTTP call — never reuse across requests.
 */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Build a new outbound trace context. When `parent` is provided, the
 * outbound trace-id and flags are inherited (this is a child span);
 * the span-id is freshly generated. When `parent` is omitted, the
 * call is the root of a new trace and the trace-id is generated.
 *
 * Default flags are `01` (sampled) — the runtime is the source of truth
 * for run telemetry, so its events are always sampled. Sample-rate
 * decisions belong to downstream collectors.
 */
export function nextTraceContext(parent?: TraceContext | null): TraceContext {
  if (parent) {
    return { traceId: parent.traceId, spanId: generateSpanId(), flags: parent.flags };
  }
  return { traceId: generateTraceId(), spanId: generateSpanId(), flags: "01" };
}
