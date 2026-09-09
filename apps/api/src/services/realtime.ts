// SPDX-License-Identifier: Apache-2.0

import { listenClient, type ListenClient } from "@appstrate/db/client";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  runUpdateEventSchema,
  runLogEventSchema,
  runMetricEventSchema,
  connectionUpdateEventSchema,
  chatSessionUpdateEventSchema,
  type RealtimeEvent,
} from "@appstrate/shared-types";

export type { RealtimeEvent };

/** Every channel name the fan-out can emit (`ping` is transport-level, not a channel). */
export type RealtimeChannel = RealtimeEvent["event"];

export const REALTIME_CHANNELS: readonly RealtimeChannel[] = [
  "run_update",
  "run_log",
  "run_metric",
  "connection_update",
  "chat_session_update",
];

type Subscriber = {
  id: string;
  filter: {
    runId?: string;
    packageId?: string;
    orgId: string;
    spaceId: string;
    isAdmin?: boolean;
    /**
     * Channels the subscriber declared interest in. `undefined` means "every
     * channel" — the historical behaviour, preserved so an existing client
     * (CLI, SDK, integrator) that never learned about the parameter keeps
     * receiving the full stream. A declared set only ever REMOVES frames the
     * subscriber would have thrown away client-side, so no consumer can lose
     * data it was actually reading.
     */
    channels?: ReadonlySet<RealtimeChannel>;
    /**
     * Actor identity for the `connection_update` channel. The trigger
     * fires for every connection on the space; the subscriber
     * forwards a row when it belongs to this actor (own connection).
     * Cross-actor shared-connection invalidations rely on the consumer
     * refetching from the server, so we don't need the shared/owner
     * tables here. Either `userId` or `endUserId` is set, never both.
     */
    userId?: string;
    endUserId?: string;
    /**
     * Does the subscriber read every run of the streamed space? Without it the
     * run channels carry only the runs this principal launched. Required
     * rather than optional: the run gate refuses a subscriber it cannot place,
     * so every caller states the answer — an SSE stream from its principal's
     * `runs:read-all` grant, the in-process `run-wait` waker from the
     * visibility its route already checked.
     */
    readAll: boolean;
  };
  send: (event: RealtimeEvent) => void;
};

const subscribers = new Map<string, Subscriber>();

/**
 * Channel gate — the cheapest possible check, so it runs FIRST in every
 * fan-out loop (before the org/space/run comparisons and, critically, before
 * `JSON.stringify` in the subscriber's `send`).
 *
 * A subscriber with no declared channel set accepts everything.
 */
function accepts(sub: Subscriber, channel: RealtimeChannel): boolean {
  return sub.filter.channels === undefined || sub.filter.channels.has(channel);
}

/**
 * Cheap pre-gate: is ANY connected subscriber interested in this channel?
 *
 * When nobody is, we skip `JSON.parse` + Zod validation of the payload
 * entirely — which is the whole point for `run_log`, whose NOTIFY payload
 * carries up to 6 KB of log `data` per row and used to be parsed and
 * validated on every insert even when every open stream discarded it.
 *
 * This can only skip work that would have produced zero `send()` calls:
 * the per-subscriber loop below re-checks `accepts()` for each subscriber,
 * so a `true` here never widens fan-out.
 */
function anyAccepts(channel: RealtimeChannel): boolean {
  for (const sub of subscribers.values()) {
    if (accepts(sub, channel)) return true;
  }
  return false;
}

/**
 * Run-read gate (RBAC spec §3.4), applied to every run channel.
 *
 * `readAll` is the whole space; without it a principal receives only the frames
 * of the runs it launched — `user_id` for a dashboard session or an API key,
 * `end_user_id` for an end-user. Strict: a frame whose actor column is NULL (an
 * end-user's run seen from a dashboard stream, or a row from a launch path that
 * predates #735) reaches `readAll` subscribers alone.
 *
 * Closed by default: a subscriber that declares neither `readAll` nor an
 * identity to match the frame against is one this gate cannot place, so it
 * receives nothing. Every subscriber therefore says which of the two it is.
 */
function readsRun(sub: Subscriber, raw: Record<string, unknown>): boolean {
  if (sub.filter.readAll) return true;
  if (sub.filter.endUserId !== undefined) return raw.end_user_id === sub.filter.endUserId;
  if (sub.filter.userId !== undefined) return raw.user_id === sub.filter.userId;
  return false;
}

/** Convert snake_case keys from PG NOTIFY to camelCase for API consistency. */
function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

function handleRunUpdate(payload: string): void {
  try {
    if (!anyAccepts("run_update")) return;
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const parsed = runUpdateEventSchema.safeParse(snakeToCamel(raw));
    if (!parsed.success) {
      logger.error("run_update payload failed schema validation", {
        issues: parsed.error.issues,
      });
      return;
    }
    for (const sub of subscribers.values()) {
      if (!accepts(sub, "run_update")) continue;
      if (sub.filter.orgId !== raw.org_id) continue;
      if (sub.filter.spaceId !== raw.space_id) continue;
      if (sub.filter.runId && sub.filter.runId !== raw.id) continue;
      if (sub.filter.packageId && sub.filter.packageId !== raw.package_id) continue;
      // Run-read gate: the payload carries both actor columns
      // (packages/db/src/notify.ts), so ownership is an exact match.
      if (!readsRun(sub, raw)) continue;
      sub.send({ event: "run_update", data: parsed.data });
    }
  } catch (err) {
    logger.error("Failed to parse run_update payload", {
      error: getErrorMessage(err),
    });
  }
}

function handleRunLogInsert(payload: string): void {
  try {
    // The firehose. Every `run_logs` INSERT lands here; when no open stream
    // declared the `run_log` channel we drop it before paying for the parse.
    if (!anyAccepts("run_log")) return;
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const parsed = runLogEventSchema.safeParse(snakeToCamel(raw));
    if (!parsed.success) {
      logger.error("run_log payload failed schema validation", {
        issues: parsed.error.issues,
      });
      return;
    }
    for (const sub of subscribers.values()) {
      if (!accepts(sub, "run_log")) continue;
      if (sub.filter.orgId !== raw.org_id) continue;
      if (sub.filter.spaceId !== raw.space_id) continue;
      if (sub.filter.runId && sub.filter.runId !== raw.run_id) continue;
      if (!sub.filter.isAdmin && raw.level === "debug") continue;
      // Run-read gate: `notify_run_log_insert()` resolves the run's actor
      // alongside its space, so a log frame is gated exactly like the
      // `run_update` frame of the same run — one uniform rule across the three
      // run channels, rather than this one dropping every frame for want of an
      // actor in its payload.
      if (!readsRun(sub, raw)) continue;
      sub.send({ event: "run_log", data: parsed.data });
    }
  } catch (err) {
    logger.error("Failed to parse run_log_insert payload", {
      error: getErrorMessage(err),
    });
  }
}

// `run_metric` carries the running cumulative cost + token usage
// emitted by the event sink after each `appstrate.metric` event,
// throttled per run by the broadcaster. Routed to the same
// org/space/run/actor filters as `run_update` and `run_log_insert`
// — no isolation rule of its own. Those filters are the ONLY gate for
// this channel; do not relax without updating the broadcaster payload
// contract.
function handleRunMetric(payload: string): void {
  try {
    if (!anyAccepts("run_metric")) return;
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const parsed = runMetricEventSchema.safeParse(snakeToCamel(raw));
    if (!parsed.success) {
      logger.error("run_metric payload failed schema validation", {
        issues: parsed.error.issues,
      });
      return;
    }
    for (const sub of subscribers.values()) {
      if (!accepts(sub, "run_metric")) continue;
      if (sub.filter.orgId !== raw.org_id) continue;
      if (sub.filter.spaceId !== raw.space_id) continue;
      if (sub.filter.runId && sub.filter.runId !== raw.run_id) continue;
      if (sub.filter.packageId && sub.filter.packageId !== raw.package_id) continue;
      // Run-read gate: the broadcaster reads the run's actor into the payload
      // (RunMetricNotifyPayload), so cost and token frames follow the same
      // ownership rule as the run itself.
      if (!readsRun(sub, raw)) continue;
      sub.send({ event: "run_metric", data: parsed.data });
    }
  } catch (err) {
    logger.error("Failed to parse run_metric payload", {
      error: getErrorMessage(err),
    });
  }
}

// `connection_update` carries every INSERT/UPDATE/DELETE on
// `integration_connections` so the dashboard can patch its caches in
// real time — the orange "Reconnection required" badge, the agent
// page's member picker verdict, the integration detail's connection
// row all read off React Query keys that this event invalidates.
//
// Filter is per-space; the subscriber owns its actor identity
// (set at SSE auth time) so a member only sees their own rows. The
// payload deliberately omits `org_id` (the table has none) — tenant
// isolation is bound to the upstream SSE auth gate proving
// `spaceId ∈ orgId`.
function handleConnectionUpdate(payload: string): void {
  try {
    if (!anyAccepts("connection_update")) return;
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const parsed = connectionUpdateEventSchema.safeParse(snakeToCamel(raw));
    if (!parsed.success) {
      logger.error("connection_update payload failed schema validation", {
        issues: parsed.error.issues,
      });
      return;
    }
    const data = parsed.data;
    for (const sub of subscribers.values()) {
      if (!accepts(sub, "connection_update")) continue;
      if (sub.filter.spaceId !== raw.space_id) continue;
      // Actor filter: only fan out rows the subscriber owns. Without
      // this, every member of a space would receive every other
      // member's connection events (org-wide cache pollution).
      if (sub.filter.userId !== undefined) {
        if (raw.user_id !== sub.filter.userId) continue;
      } else if (sub.filter.endUserId !== undefined) {
        if (raw.end_user_id !== sub.filter.endUserId) continue;
      } else {
        // No actor filter on the subscription — skip rather than leak.
        continue;
      }
      sub.send({ event: "connection_update", data });
    }
  } catch (err) {
    logger.error("Failed to parse connection_update payload", {
      error: getErrorMessage(err),
    });
  }
}

// `chat_session_update` is a space-emitted change SIGNAL from the
// chat module (packages/module-chat/src/realtime.ts): the payload carries
// only the owner identity, and the client refetches the session list.
// Chat sessions are strictly user-owned (org+user scoped, no space
// dimension), so fan-out gates on org + exact user match. End-user
// subscriptions never receive chat frames (chat has no end-user surface);
// subscriptions without an actor are skipped rather than leaked to.
function handleChatSessionUpdate(payload: string): void {
  try {
    if (!anyAccepts("chat_session_update")) return;
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const parsed = chatSessionUpdateEventSchema.safeParse(snakeToCamel(raw));
    if (!parsed.success) {
      logger.error("chat_session_update payload failed schema validation", {
        issues: parsed.error.issues,
        raw,
      });
      return;
    }
    for (const sub of subscribers.values()) {
      if (!accepts(sub, "chat_session_update")) continue;
      if (sub.filter.orgId !== raw.org_id) continue;
      if (sub.filter.userId === undefined || sub.filter.userId !== raw.user_id) continue;
      sub.send({ event: "chat_session_update", data: parsed.data });
    }
  } catch (err) {
    logger.error("Failed to parse chat_session_update payload", {
      error: getErrorMessage(err),
    });
  }
}

/** Every PG channel the fan-out listens on, with the handler installed for it. */
const LISTEN_SPECS: Record<string, (payload: string) => void> = {
  run_update: handleRunUpdate,
  run_log_insert: handleRunLogInsert,
  run_metric: handleRunMetric,
  connection_update: handleConnectionUpdate,
  chat_session_update: handleChatSessionUpdate,
};

/** One installation: the in-flight (or settled) init, and the channels `listen` resolved for. */
type RealtimeInitState = { promise: Promise<void> | null; installed: Set<string> };

const initState: RealtimeInitState = { promise: null, installed: new Set() };

async function installChannels(
  listen: ListenClient["listen"],
  installed: Set<string>,
): Promise<void> {
  for (const [channel, handler] of Object.entries(LISTEN_SPECS)) {
    if (installed.has(channel)) continue;
    // Marked only AFTER the ack: flagging first loses the retry, and
    // re-listening a resolved channel doubles the fan-out.
    await listen(channel, handler);
    installed.add(channel);
  }
  logger.info("Realtime LISTEN channels initialized", { channels: installed.size });
}

/**
 * Install the PG LISTEN channels the realtime fan-out reads. Concurrent callers
 * share the in-flight promise; a rejection drops it so the next call retries only
 * the missing channels. `listen` and the state are injected in tests.
 */
export function initRealtime(
  listen: ListenClient["listen"] = listenClient.listen,
  state: RealtimeInitState = initState,
): Promise<void> {
  state.promise ??= installChannels(listen, state.installed).catch((err: unknown) => {
    state.promise = null;
    throw err;
  });
  return state.promise;
}

/** Is every LISTEN channel installed? Read by `/health` (`checks.realtime`). */
export function realtimeReady(): boolean {
  return initState.installed.size === Object.keys(LISTEN_SPECS).length;
}

export function addSubscriber(sub: Subscriber): void {
  subscribers.set(sub.id, sub);
}

export function removeSubscriber(id: string): void {
  subscribers.delete(id);
}

/**
 * Test-only introspection — number of registered subscribers.
 *
 * Used to assert that a stream dropped for backpressure actually
 * unregisters (the drop happens inside the route's stream closure, whose
 * subscriber id is generated internally). Compare a delta, not an absolute:
 * the whole test process shares this map.
 */
export function activeSubscriberCount(): number {
  return subscribers.size;
}
