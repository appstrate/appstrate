// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded in-process concurrency for the Pi chat engine.
 *
 * Each Pi chat turn drives a `@earendil-works/pi-coding-agent` session
 * in-process inside the single `apps/api` process — which also serves runs,
 * auth, and everything else. Without a ceiling a burst of concurrent chats would
 * spin up an unbounded number of Pi sessions (each holding an upstream inference
 * connection + MCP client) and exhaust memory/CPU for the whole instance. This
 * is a simple counting gate (one counter per instance); when saturated
 * `acquirePiChatSlot()` returns `null` so the engine can 429
 * (see {@link chatCapacityResponse}) and the client backs off instead of piling
 * on more sessions.
 *
 * The cap is read from `CHAT_PI_MAX_CONCURRENCY` (positive integer, default 6).
 * Higher limits used by the performance harness must remain explicit until
 * replica resources and cloud concurrency have been validated. The module knob
 * is read straight from `process.env` because the chat module also runs without
 * the platform env surface in tests and standalone OSS wiring.
 */

import { logger } from "../logger.ts";

const DEFAULT_MAX_CONCURRENCY = 6;
const ENV_VAR = "CHAT_PI_MAX_CONCURRENCY";

/** A reserved session slot. `release()` is idempotent (safe to call twice). */
export interface PiChatSlot {
  release(): void;
}

let active = 0;
let highWaterMark = 0;
let rejected = 0;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export const piChatMaxConcurrency = (): number => {
  const raw = process.env[ENV_VAR];
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
};

/** Whether the cap is the built-in default rather than an operator decision. */
export const piChatConcurrencyIsDefault = (): boolean => {
  const raw = process.env[ENV_VAR];
  if (!raw) return true;
  const n = Number.parseInt(raw, 10);
  return !(Number.isInteger(n) && n > 0);
};

/**
 * Saturation snapshot for capacity sizing.
 *
 * The cap alone tells an operator nothing: a process that never exceeded 2
 * concurrent turns and one that sits pinned at the ceiling look identical from
 * outside, and only the second needs a bigger cap. `highWaterMark` is the most
 * concurrent turns this process ever held; `rejected` counts the 429s it
 * answered. Both are process-local and reset on restart — they are a sizing
 * signal, not a ledger.
 */
export const piChatConcurrencyStats = (): {
  active: number;
  highWaterMark: number;
  rejected: number;
  max: number;
} => ({ active, highWaterMark, rejected, max: piChatMaxConcurrency() });

/** Test seam — production has no reason to forget the high-water mark. */
export const resetPiChatConcurrencyStats = (): void => {
  highWaterMark = 0;
  rejected = 0;
};

/**
 * Try to reserve a session slot. Returns the slot when below the cap, or `null`
 * when the engine is already at capacity (caller should 429).
 */
export const acquirePiChatSlot = (): PiChatSlot | null => {
  if (active >= piChatMaxConcurrency()) {
    rejected += 1;
    return null;
  }
  active += 1;
  if (active > highWaterMark) highWaterMark = active;
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
 * Warn once at boot when the cap is still the built-in default.
 *
 * EVERY chat turn holds a slot for its whole duration, so this cap is the
 * ceiling on concurrent chats per API process — the (cap + 1)-th simultaneous
 * chat is refused. The default of 6 is a conservative product value, not a
 * sizing decision, and the only measurements that exist are local. An operator
 * who never saw this line would discover the ceiling from user reports.
 */
export function warnIfDefaultChatConcurrency(): void {
  if (!piChatConcurrencyIsDefault()) return;
  logger.warn(
    `${ENV_VAR} is unset — chat is capped at ${DEFAULT_MAX_CONCURRENCY} concurrent turns per API process. ` +
      "Set it from measured capacity before serving production chat traffic.",
  );
}

/**
 * RFC 9457 `429` returned (instead of a stream) when the Pi chat engine is at
 * its session cap, so the client backs off rather than the instance spinning up
 * unbounded sessions.
 */
export function chatCapacityResponse(): Response {
  const retryAfterSeconds = 5;
  // The one line an operator needs to size the cap: a refusal is only
  // actionable next to the ceiling that produced it and how often it has been
  // hit. Logged here rather than at the call site so every refusal reports it.
  logger.warn("chat at capacity — turn refused", piChatConcurrencyStats());
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
