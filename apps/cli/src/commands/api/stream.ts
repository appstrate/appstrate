// SPDX-License-Identifier: Apache-2.0

import type { WriteOutMetrics } from "./write-out.ts";

export interface ChunkSink {
  write(chunk: Uint8Array): void;
  close(): Promise<void>;
}

export function streamChunkSink(target: { write(chunk: Uint8Array | string): void }): ChunkSink {
  return {
    write: (c) => target.write(c),
    close: async () => {
      /* stdout/stderr not ours to close */
    },
  };
}

export function fileChunkSink(path: string): ChunkSink {
  const writer = Bun.file(path).writer();
  return {
    write: (c) => void writer.write(c),
    close: async () => {
      await writer.end();
    },
  };
}

/**
 * Shared byte-read loop: pull chunks from `res.body`, race each read
 * against an abort Promise, update metrics (first-byte timing +
 * cumulative download size), and forward non-empty chunks to `sink`.
 * Throws if the signal aborts mid-stream (reason preserved as cause).
 *
 * Unified for both the inline `-o`-less stdout/stderr path and the
 * file-output path — previously duplicated with subtly different
 * metric handling.
 */
export async function consumeResponseStream(
  res: Response,
  sink: (chunk: Uint8Array) => void,
  signal: AbortSignal,
  metrics: WriteOutMetrics,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const abortPromise = abortAsRejection(signal);
  while (true) {
    const chunk = await Promise.race([reader.read(), abortPromise]);
    if (chunk.done) break;
    if (chunk.value && chunk.value.byteLength > 0) {
      if (metrics.tFirstByte === null) metrics.tFirstByte = performance.now();
      metrics.sizeDownload += chunk.value.byteLength;
      sink(chunk.value);
    }
  }
}

/**
 * Return a Promise that rejects as soon as `signal` aborts, preserving
 * the abort reason as the rejection's `cause` so downstream classifier
 * logic can tell SIGINT apart from `--max-time` (TimeoutError).
 *
 * Never resolves otherwise — meant to lose `Promise.race` every time
 * the real work completes first.
 */
export function abortAsRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal.reason)), { once: true });
  });
}

function abortError(reason: unknown): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError", cause: reason });
}
