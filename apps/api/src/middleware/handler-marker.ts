// SPDX-License-Identifier: Apache-2.0

/**
 * Tag a middleware so its MOUNT can be read back off Hono's route table.
 *
 * Several invariants in this API are properties of *where* a middleware is
 * mounted rather than of what it does at runtime — "this route de-duplicates
 * on `Idempotency-Key`" (`middleware/idempotency.ts`), "this route proves
 * permission before it looks an agent up" (`middleware/guards.ts`). A
 * hand-maintained list of such routes drifts away from the mounts silently; a
 * marker carried by the middleware itself cannot.
 *
 * A symbol property rather than `handler.name`: a name survives neither
 * wrapping nor minification. The property survives minification, and survives
 * wrapping because {@link hasHandlerMarker} explicitly unwraps.
 */

import { findTargetHandler } from "hono/utils/handler";

/** Stamp `marker` on `handler` and return it, for a factory to `return` directly. */
export function markHandler<T extends object>(handler: T, marker: symbol): T {
  Object.defineProperty(handler, marker, { value: true });
  return handler;
}

/**
 * True when `handler` carries `marker`.
 *
 * The marker is read *through* Hono's own handler wrapping. `app.route(path,
 * sub)` re-wraps every handler of `sub` when the sub-app installed its own
 * `onError()` (hono 4.12 `hono-base.js` `route()`), keeping the original only
 * under the `COMPOSED_HANDLER` property. A naive property read on the wrapper
 * returns `undefined`, so every marker mounted on a sub-router with an
 * `onError()` would silently read as absent. `findTargetHandler` is Hono's own
 * recursive unwrapper for exactly that property, so this tracks their wrapping
 * instead of guessing at it.
 */
export function hasHandlerMarker(handler: unknown, marker: symbol): boolean {
  if (typeof handler !== "function") return false;
  const target = findTargetHandler(handler as (...args: never[]) => unknown);
  return (target as unknown as Record<symbol, unknown>)[marker] === true;
}
