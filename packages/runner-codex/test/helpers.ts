// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared test helpers for the runner-codex suite. Extracted so the NDJSON
 * stream/sink/vend fakes are defined once instead of copied per test file.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

/** A ReadableStream emitting the given NDJSON lines then closing. */
export function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line + "\n"));
      controller.close();
    },
  });
}

export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Capturing EventSink. */
export function makeSink() {
  const events: RunEvent[] = [];
  let result: RunResult | undefined;
  return {
    events,
    get result() {
      return result;
    },
    sink: {
      async handle(e: RunEvent) {
        events.push(e);
      },
      async finalize(r: RunResult) {
        result = r;
      },
    },
  };
}

/** The runner ignores the bundle; a minimal stub satisfies the type at runtime. */
export const bundle = {} as never;

export function vendFetch(body: {
  access_token: string;
  account_id?: string | null;
}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}
