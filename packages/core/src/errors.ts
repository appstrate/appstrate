// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract a string message from an unknown error.
 * Use at boundaries where errors are caught and surfaced to humans/logs.
 * @param err - The unknown error value (typically from a catch block)
 * @returns The error's `message` if it's an Error instance, otherwise `String(err)`
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How many `cause` links {@link formatErrorChain} will follow past the
 * outermost error. Five is well past any chain this repo builds (the deepest
 * measured is two) and keeps one pathological error from writing an unbounded
 * log line.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Render an error and every `cause` beneath it as one string: each cause after
 * `": "`, or after a space when the text so far already ends a sentence (never
 * `"refused.: Conflict"`), and a cause whose message the text already carries —
 * a wrapper that quoted it — is not written twice.
 *
 * ## Why this exists at all
 *
 * `{ cause }` is threaded through the codebase, and until this function
 * NOTHING rendered it. Two measurements, both on Bun 1.3:
 *
 *  - `new Error(outer, { cause: inner }).stack.includes(inner.message)` is
 *    **false**. V8 builds `.stack` at construction and never walks the chain,
 *    so a log line carrying `err.message` + `err.stack` — which is what the API
 *    error handler emitted — contains no trace of the cause.
 *  - pino DOES walk the chain, and needs no configuration to do it: its `err`
 *    serializer is on by default and emits `message`/`stack` with every cause
 *    appended. But it only fires for a property literally named `err` holding
 *    an `Error`, and this repo has 194 log sites passing `error:
 *    getErrorMessage(err)` — a pre-flattened **string** — against 1 passing an
 *    Error object. So the library's own path was live the whole time and
 *    reached nothing.
 *
 * Renaming 194 call sites and changing the emitted field from a string to an
 * object is a far larger change than this function, for the same output, and
 * it would not help the one renderer that is not pino at all: the CLI's
 * `formatError`, which writes to a terminal. Hence a plain formatter, used at
 * the boundaries that actually hold an `Error` and render it for a human.
 *
 * ## What it is NOT for
 *
 * The chain is operator-facing. A `cause` routinely carries internal
 * detail — SQL constraint names, upstream URLs, credential-adjacent context —
 * so it belongs in a log, never in an HTTP response body. `ApiError`'s RFC 9457
 * serialiser (`toProblemDetail`) deliberately reads `message` and never
 * `cause`; keep it that way.
 *
 * @param err - The unknown error value (typically from a catch block)
 * @returns `getErrorMessage(err)` when there is no cause — so this is a drop-in
 *   for it — otherwise the outer message followed by each cause's message.
 */
export function formatErrorChain(err: unknown): string {
  const head = getErrorMessage(err);
  // Happy path: one `instanceof` and one property read, no allocation.
  if (!(err instanceof Error) || err.cause === undefined || err.cause === null) return head;

  let out = head;
  // A cause chain can be cyclic (`a.cause = b; b.cause = a`) — a plain walk
  // never terminates. Identity-tracking the visited errors is the only guard
  // that works, since two distinct errors may share a message.
  const seen = new Set<unknown>([err]);
  let cursor: unknown = err.cause;
  let depth = 0;

  while (cursor !== undefined && cursor !== null) {
    if (seen.has(cursor)) {
      out = appendCause(out, "[circular cause]");
      break;
    }
    if (depth >= MAX_CAUSE_DEPTH) {
      out = appendCause(out, "[cause chain truncated]");
      break;
    }
    seen.add(cursor);
    const message = getErrorMessage(cursor);
    if (!carries(out, message)) out = appendCause(out, message);
    depth += 1;
    cursor = cursor instanceof Error ? cursor.cause : undefined;
  }

  return out;
}

/**
 * Whether `text` already quotes `message` whole — not inside a longer word, so
 * a cause `"timeout"` is still written after `"2 timeouts"`. An empty message
 * has nothing to add.
 */
function carries(text: string, message: string): boolean {
  if (message.length === 0) return true;
  const word = /[\p{L}\p{N}_]/u;
  const opensWord = word.test(message[0]!);
  const closesWord = word.test(message[message.length - 1]!);
  for (let at = text.indexOf(message); at !== -1; at = text.indexOf(message, at + 1)) {
    const before = text[at - 1];
    const after = text[at + message.length];
    const cleanStart = !opensWord || before === undefined || !word.test(before);
    const cleanEnd = !closesWord || after === undefined || !word.test(after);
    if (cleanStart && cleanEnd) return true;
  }
  return false;
}

/** `text: cause`, or `text cause` when `text` already ends a sentence. */
function appendCause(text: string, cause: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${cause}` : `${text}: ${cause}`;
}
