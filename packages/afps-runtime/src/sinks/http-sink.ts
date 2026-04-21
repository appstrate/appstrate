// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { randomUUID } from "node:crypto";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { RunEvent } from "../types/run-event.ts";
import type { RunResult } from "../types/run-result.ts";
import { buildCloudEventEnvelope } from "../events/cloudevents.ts";
import { sign } from "../events/signing.ts";

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
  private sequence = 0;

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
  }

  async handle(event: RunEvent): Promise<void> {
    const id = this.generateId();
    const nowMs = this.now();
    const cloudEvent = buildCloudEventEnvelope({
      event,
      sequence: this.sequence++,
      id,
      nowMs,
    });
    const body = JSON.stringify(cloudEvent);
    await this.sendSigned(this.url, id, nowMs, body);
  }

  async finalize(result: RunResult): Promise<void> {
    const id = this.generateId();
    const nowMs = this.now();
    const body = JSON.stringify(result);
    await this.sendSigned(this.finalizeUrl, id, nowMs, body);
  }

  private async sendSigned(url: string, id: string, nowMs: number, body: string): Promise<void> {
    const timestampSec = Math.floor(nowMs / 1000);
    const headers = sign({
      msgId: id,
      timestampSec,
      body,
      secret: this.runSecret,
    });

    let attempt = 0;
    let lastError: unknown = undefined;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/cloudevents+json" },
          body,
        });

        if (res.ok) return;

        if (res.status < 500 && res.status !== 429) {
          throw new NonRetryableHttpError(res.status, res.statusText);
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
  ) {
    super(`HttpSink: non-retryable ${status} ${statusText}`);
    this.name = "NonRetryableHttpError";
  }
}
