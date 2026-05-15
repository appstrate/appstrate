// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { randomUUID } from "node:crypto";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "@afps-spec/types";
import type { RunResult } from "../types/run-result.ts";
import { buildCloudEventEnvelope } from "../events/cloudevents.ts";
import { sign } from "../events/signing.ts";
import {
  formatTraceparent,
  nextTraceContext,
  parseTraceparent,
  type TraceContext,
} from "../transport/trace-context.ts";

export interface HttpSinkOptions {
  /**
   * Target URL. Receives one POST per event plus one POST per
   * `finalize` (to `<url>/finalize` by default — override via
   * `finalizeUrl`).
   */
  url: string;
  /** Override for the finalize POST target. Defaults to `${url}/finalize`. */
  finalizeUrl?: string;
  /**
   * Run secret (raw UTF-8 bytes). The only place a secret crosses the
   * API boundary is the constructor — never persisted, never logged.
   */
  runSecret: string;
  /**
   * Override the event-id generator (default: `crypto.randomUUID()`).
   * Useful for deterministic tests and for environments that prefer
   * time-sortable identifiers (UUIDv7 / ULID).
   */
  generateId?: () => string;
  /**
   * Override the current-time source (Unix ms). Default:
   * `Date.now()`. Useful for deterministic tests.
   */
  now?: () => number;
  /** Max HTTP attempts per event. Default: 4 (initial + 3 retries). */
  maxAttempts?: number;
  /** Initial retry delay in ms. Default: 500. Doubled per attempt. */
  initialBackoffMs?: number;
  /** Cap on retry delay (ms). Default: 30_000. */
  maxBackoffMs?: number;
  /** Low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * W3C Trace Context parent (header value). When provided, the sink
   * inherits the trace-id + flags so the run becomes a child span of an
   * existing distributed trace (e.g. the platform request that spawned
   * the run). When absent, the sink generates a fresh trace-id at
   * construction time and treats every event/finalize as a child span
   * of that root.
   *
   * Each outbound HTTP call gets a freshly generated span-id — never
   * reused across requests, per the W3C spec.
   */
  traceparent?: string;
}

/**
 * Stream {@link RunEvent}s to a URL using CloudEvents 1.0 + Standard
 * Webhooks.
 *
 * Each event is POSTed with these headers:
 *
 * ```
 * webhook-id: <uuid>
 * webhook-timestamp: <unix-sec>
 * webhook-signature: v1,<hmac-sha256-base64>
 * Content-Type: application/cloudevents+json
 * ```
 *
 * Transient failures (network error, 5xx, 429) are retried with
 * exponential backoff + jitter. Non-transient 4xx errors propagate.
 */
// ─── Diagnostic trace ─────────────────────────────────────────────
//
// `[run-trace]`-prefixed JSON lines on stderr — same protocol as the
// pi-runner trace, so both sides of the pipeline correlate by greping
// `[run-trace]`. Gated by `APPSTRATE_RUN_TRACE=1` so production runs pay
// only a branch check.
const RUN_TRACE_ENABLED =
  typeof process !== "undefined" && process.env?.["APPSTRATE_RUN_TRACE"] === "1";

function runTrace(event: string, data: Record<string, unknown>): void {
  if (!RUN_TRACE_ENABLED) return;
  try {
    process.stderr.write(`[run-trace] ${JSON.stringify({ ts: Date.now(), event, ...data })}\n`);
  } catch {
    /* never break the sink on a trace write failure */
  }
}

// Per-process counter of POSTs the HttpSink is awaiting (initial attempt
// or retry). Exposed via getHttpSinkPendingPosts so the entrypoint can
// log it just before process.exit(), since killing in-flight POSTs is
// the prime suspect for missing run_logs rows.
let pendingPosts = 0;

export function getHttpSinkPendingPosts(): number {
  return pendingPosts;
}

export class HttpSink implements EventSink {
  private readonly url: string;
  private readonly finalizeUrl: string;
  private readonly runSecret: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly traceParent: TraceContext | null;
  // Sequence numbers start at 1. The ingestion endpoint accepts an event
  // only when `envelope.sequence === run.lastEventSequence + 1`, and
  // `lastEventSequence` defaults to 0 on run creation — so the first
  // emitted event must be 1 or it is dropped as a replay.
  private sequence = 1;

  constructor(opts: HttpSinkOptions) {
    this.url = opts.url;
    this.finalizeUrl = opts.finalizeUrl ?? `${opts.url.replace(/\/$/, "")}/finalize`;
    this.runSecret = opts.runSecret;
    this.generateId = opts.generateId ?? randomUUID;
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? fetch;
    // Inherit the parent trace if a valid traceparent was supplied,
    // otherwise root a fresh trace. nextTraceContext only generates a
    // root context when `parent` is null/undefined; we capture the root
    // here so every subsequent send shares the trace-id.
    const parent = parseTraceparent(opts.traceparent);
    this.traceParent = parent ?? nextTraceContext();
  }

  async handle(event: RunEvent): Promise<void> {
    const id = this.generateId();
    const nowMs = this.now();
    const seq = this.sequence++;
    const cloudEvent = buildCloudEventEnvelope({
      event,
      sequence: seq,
      id,
      nowMs,
    });
    const body = JSON.stringify(cloudEvent);
    runTrace("http-sink.handle.start", {
      sequence: seq,
      webhookId: id,
      type: event.type,
      bodyBytes: body.length,
    });
    pendingPosts += 1;
    const t0 = Date.now();
    try {
      await this.sendSigned(this.url, id, nowMs, body, { sequence: seq, type: event.type });
      runTrace("http-sink.handle.end", {
        sequence: seq,
        webhookId: id,
        type: event.type,
        latencyMs: Date.now() - t0,
        pendingPosts: pendingPosts - 1,
      });
    } catch (err) {
      runTrace("http-sink.handle.error", {
        sequence: seq,
        webhookId: id,
        type: event.type,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      pendingPosts -= 1;
    }
  }

  async finalize(result: RunResult): Promise<void> {
    const id = this.generateId();
    const nowMs = this.now();
    const body = JSON.stringify(result);
    runTrace("http-sink.finalize.start", {
      webhookId: id,
      bodyBytes: body.length,
      pendingPosts,
    });
    pendingPosts += 1;
    const t0 = Date.now();
    try {
      await this.sendSigned(this.finalizeUrl, id, nowMs, body, { sequence: -1, type: "finalize" });
      runTrace("http-sink.finalize.end", {
        webhookId: id,
        latencyMs: Date.now() - t0,
        pendingPosts: pendingPosts - 1,
      });
    } catch (err) {
      runTrace("http-sink.finalize.error", {
        webhookId: id,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      pendingPosts -= 1;
    }
  }

  private async sendSigned(
    url: string,
    id: string,
    nowMs: number,
    body: string,
    trace?: { sequence: number; type: string },
  ): Promise<void> {
    const timestampSec = Math.floor(nowMs / 1000);
    const headers = sign({
      msgId: id,
      timestampSec,
      body,
      secret: this.runSecret,
    });
    // Fresh span-id per outbound call. Trace-id + flags inherited from
    // the constructor-time root so every event/finalize is a child span
    // of the same trace.
    const traceparent = formatTraceparent(nextTraceContext(this.traceParent));

    let attempt = 0;
    let lastError: unknown = undefined;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      const attemptT0 = Date.now();
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/cloudevents+json",
            traceparent,
          },
          body,
        });

        runTrace("http-sink.attempt", {
          ...(trace ?? {}),
          webhookId: id,
          attempt,
          status: res.status,
          latencyMs: Date.now() - attemptT0,
        });

        if (res.ok) return;

        if (res.status < 500 && res.status !== 429) {
          // Capture a peek of the response body. Platform errors are
          // RFC 9457 `application/problem+json` envelopes whose `code` /
          // `detail` fields are the only machine-readable explanation
          // for the failure (e.g. `run_sink_closed`, `run_sink_expired`,
          // `invalid_signature`). Discarding them turns a one-line
          // diagnosis into a debug session.
          const detail = await peekErrorDetail(res);
          throw new NonRetryableHttpError(res.status, res.statusText, detail);
        }

        lastError = new Error(`HttpSink: retryable ${res.status} ${res.statusText}`);
      } catch (err) {
        if (err instanceof NonRetryableHttpError) throw err;
        lastError = err;
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(this.backoff(attempt));
      }
    }

    throw lastError ?? new Error("HttpSink: request failed without a captured error");
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.initialBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
    const jitter = base * 0.25 * Math.random();
    return Math.floor(base + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class NonRetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly detail?: string,
  ) {
    const suffix = detail ? ` — ${detail}` : "";
    super(`HttpSink: non-retryable ${status} ${statusText}${suffix}`);
    this.name = "NonRetryableHttpError";
  }
}

/**
 * Best-effort body extraction from a non-OK response. Returns a short
 * `code: <code>, detail: <detail>` string for RFC 9457 problem+json
 * envelopes (the platform's standard error shape), a plain truncated
 * preview otherwise, or `undefined` if the body can't be read.
 *
 * Bounded to ~512 bytes to keep error messages scannable in CI logs and
 * to avoid copying multi-MB error pages from misconfigured proxies.
 */
async function peekErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const trimmed = text.length > 512 ? text.slice(0, 512) + "…" : text;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const code = typeof parsed.code === "string" ? parsed.code : undefined;
        const detail = typeof parsed.detail === "string" ? parsed.detail : undefined;
        if (code && detail) return `code: ${code}, detail: ${detail}`;
        if (code) return `code: ${code}`;
        if (detail) return detail;
      } catch {
        /* fall through to raw preview */
      }
    }
    return trimmed;
  } catch {
    return undefined;
  }
}
