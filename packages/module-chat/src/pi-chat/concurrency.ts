// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded in-process concurrency for the Pi subscription chat engine.
 *
 * Each subscription chat turn drives a `@mariozechner/pi-coding-agent` session
 * in-process inside the single `apps/api` process — which also serves runs,
 * auth, and everything else. Without a ceiling a burst of concurrent chats would
 * spin up an unbounded number of Pi sessions (each holding an upstream inference
 * connection + MCP client) and exhaust memory/CPU for the whole instance. This
 * is a simple counting gate (one counter per instance); when saturated
 * `acquirePiChatSlot()` returns `null` so the engine can 429
 * (see {@link chatCapacityResponse}) and the client backs off instead of piling
 * on more sessions.
 *
 * The cap is read from `CHAT_PI_MAX_CONCURRENCY` (positive integer, default 6) —
 * an opt-in module knob read straight from `process.env`, not a core env-schema
 * field (the chat module runs without the platform env surface in tests/OSS
 * standalone wiring).
 */

import { logger } from "../logger.ts";

const DEFAULT_MAX_CONCURRENCY = 6;
const ENV_VAR = "CHAT_PI_MAX_CONCURRENCY";

/** A reserved session slot. `release()` is idempotent (safe to call twice). */
export interface PiChatSlot {
  release(): void;
}

let active = 0;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export const piChatMaxConcurrency = (): number => {
  const raw = process.env[ENV_VAR];
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
};

/**
 * Try to reserve a session slot. Returns the slot when below the cap, or `null`
 * when the engine is already at capacity (caller should 429).
 */
export const acquirePiChatSlot = (): PiChatSlot | null => {
  if (active >= piChatMaxConcurrency()) return null;
  active += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      active -= 1;
    },
  };
};

/**
 * Wrap a stream so `onClose` runs exactly once when it terminates — used to
 * release a concurrency slot after the response body has fully drained, not
 * when the producer function returns. Fires on every terminal path: normal
 * completion, downstream cancellation (client disconnected while the
 * persistence drain also stopped), and source error — so the slot can never
 * leak. (A `TransformStream` with a `flush` hook misses the cancellation path:
 * Bun does not invoke the transformer's `cancel` callback.)
 */
export function releaseOnClose<T>(
  stream: ReadableStream<T>,
  onClose: () => void,
): ReadableStream<T> {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    try {
      onClose();
    } catch (err) {
      logger.warn("pi chat slot release failed", { err: String(err) });
    }
  };
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        fire();
        controller.error(err);
        return;
      }
      if (result.done) {
        fire();
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      fire();
      await reader.cancel(reason);
    },
  });
}

/**
 * RFC 9457 `429` returned (instead of a stream) when the Pi chat engine is at
 * its session cap, so the client backs off rather than the instance spinning up
 * unbounded sessions.
 */
export function chatCapacityResponse(): Response {
  const retryAfterSeconds = 5;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/chat-capacity",
      title: "Too Many Requests",
      status: 429,
      detail: `Le service de chat est temporairement saturé. Réessayez dans quelques instants.`,
      code: "chat_capacity",
      retry_after: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
