// SPDX-License-Identifier: Apache-2.0

/**
 * Explicit-stop registry: maps an in-flight stream id to the AbortController that
 * cancels its generation. Disconnect ≠ stop — a client disconnect must NOT abort
 * generation (that was the data-loss bug), so only an explicit stop request
 * (`POST /api/chat/sessions/:id/stop`) reaches here.
 *
 * In-process only. Multi-instance stop (broadcasting an abort to whichever node
 * owns the producer) would ride the platform's existing cancel Pub/Sub — a
 * follow-up; today a stop is a best-effort, same-node operation.
 */

const controllers = new Map<string, AbortController>();

export function registerStopController(streamId: string, controller: AbortController): void {
  controllers.set(streamId, controller);
}

export function unregisterStopController(streamId: string): void {
  controllers.delete(streamId);
}

/** Abort the generation for a stream id. Returns false if no active stream matched. */
export function stopStream(streamId: string): boolean {
  const controller = controllers.get(streamId);
  if (!controller) return false;
  controller.abort();
  controllers.delete(streamId);
  return true;
}
