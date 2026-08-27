// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import { organizationMembers, runs } from "@appstrate/db/schema";
import { scopedWhere } from "../lib/db-helpers.ts";
import { addSubscriber, removeSubscriber, REALTIME_CHANNELS } from "../services/realtime.ts";
import type { RealtimeEvent, RealtimeChannel } from "../services/realtime.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { validateApiKey } from "../services/api-keys.ts";
import { resolveApiKeyPermissions } from "../lib/permissions.ts";
import { validateSpaceInOrg } from "../middleware/space-context.ts";
import { assertSpaceId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import type { OrgRole } from "../types/index.ts";

/**
 * Hard cap on frames queued for one subscriber before we give up on it.
 *
 * Sized well above any legitimate burst: the loudest producer is `run_log`
 * on a verbose single-run stream, and a run that emits 2 000 unread log
 * frames faster than the socket accepts them is a consumer that has stopped
 * reading, not a fast run.
 */
const MAX_PENDING_EVENTS = 2_000;

/**
 * How long a single frame write may stay unsettled before the connection is
 * treated as dead. Generous on purpose — frames are small and the keep-alive
 * period is 30 s, so exceeding this means the peer is not draining at all.
 */
const WRITE_DEADLINE_MS = 60_000;

/** Strip large user-content fields from SSE payloads for non-verbose consumers. */
function stripPayload(evt: RealtimeEvent): Record<string, unknown> {
  if (evt.event === "run_log") {
    const { data: _data, ...rest } = evt.data;
    return rest;
  }
  // `run_update` carries no user-content field (the trigger never emits
  // `result`); `run_metric` is bounded numerics + four ids; `connection_update`
  // is identifiers + flags — all pass through unmodified.
  return evt.data;
}

/**
 * Parse the optional `?channels=` subscription filter.
 *
 * Contract (deliberately fail-open):
 *   • parameter absent            → `undefined` = subscribe to every channel.
 *     This is what every pre-existing client (CLI, SDKs, integrators) sends,
 *     so their stream is byte-identical to before.
 *   • parameter present           → the intersection with the known channel
 *     names. Unknown tokens are ignored rather than rejected so adding a
 *     channel later can't 400 an older client that hardcoded a list.
 *   • nothing recognised          → `undefined` (every channel) rather than an
 *     empty subscription. A typo must degrade to "too much data", never to a
 *     silently dead stream.
 */
function parseChannels(raw: string | undefined): ReadonlySet<RealtimeChannel> | undefined {
  if (raw === undefined) return undefined;
  const requested = new Set<RealtimeChannel>();
  for (const token of raw.split(",")) {
    const name = token.trim();
    const known = REALTIME_CHANNELS.find((c) => c === name);
    if (known) requested.add(known);
  }
  return requested.size > 0 ? requested : undefined;
}

interface SSEAuthResult {
  userId: string;
  orgId: string;
  role: OrgRole;
  /**
   * Admin level derived from the resolved role (`admin`/`owner`), never
   * hardcoded. Drives the subscriber filter's `isAdmin` flag — the only
   * thing it gates is debug-level `run_log` visibility
   * (services/realtime.ts).
   */
  isAdmin: boolean;
  spaceId: string;
}

const isAdminRole = (role: OrgRole): boolean => role === "admin" || role === "owner";

/**
 * Validate auth for SSE endpoints.
 *
 * Supports two auth methods:
 *  1. API key via `?token=ask_...` query param (EventSource can't send headers)
 *  2. Cookie session (existing behavior)
 *
 * Org context: `?orgId=` query param (cookie auth only — API key already resolves org).
 *
 * API keys go through the same canonical scope resolution as the HTTP
 * pipeline (`resolveApiKeyPermissions` — key scopes ∩ creator's live role)
 * and must carry `runs:read` to open any run stream; a valid key without
 * that grant is rejected with 403 instead of silently inheriting admin.
 */
async function validateSSEAuth(c: {
  req: {
    raw: Request;
    query: (key: string) => string | undefined;
  };
}): Promise<SSEAuthResult | null> {
  // 1. Try API key auth via ?token= query param
  const token = c.req.query("token");
  if (token?.startsWith("ask_")) {
    const keyInfo = await validateApiKey(token);
    if (!keyInfo) return null;

    const permissions = resolveApiKeyPermissions(keyInfo.scopes, keyInfo.creatorRole);
    if (!permissions.has("runs:read")) {
      throw forbidden("API key does not have the 'runs:read' scope");
    }

    // The key's `spaceId` comes straight off the `api_keys` row and never
    // reaches `validateSpaceInOrg` (the key already proves org+space binding),
    // so this is the shape check for that path — an un-migrated `api_keys`
    // table would otherwise open a stream on an `app_` id in silence.
    assertSpaceId(keyInfo.spaceId);

    return {
      userId: keyInfo.userId,
      orgId: keyInfo.orgId,
      role: keyInfo.creatorRole,
      isAdmin: isAdminRole(keyInfo.creatorRole),
      spaceId: keyInfo.spaceId,
    };
  }

  // 2. Fallback: cookie session
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return null;

  const orgId = c.req.query("orgId");
  if (!orgId) return null;

  // Verify org membership
  const rows = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      scopedWhere(organizationMembers, {
        orgId,
        extra: [eq(organizationMembers.userId, session.user.id)],
      }),
    )
    .limit(1);

  if (!rows[0]) return null;

  const spaceId = c.req.query("spaceId");
  if (!spaceId) return null;

  // Validate space belongs to org
  const space = await validateSpaceInOrg(spaceId, orgId);
  if (!space) return null;

  return {
    userId: session.user.id,
    orgId,
    role: rows[0].role,
    isAdmin: isAdminRole(rows[0].role),
    spaceId,
  };
}

/** Open an SSE stream with a subscriber filter, verbose toggle, and ping keep-alive. */
function openRealtimeStream(
  c: Parameters<typeof streamSSE>[0],
  subId: string,
  filter: {
    runId?: string;
    packageId?: string;
    orgId: string;
    spaceId: string;
    isAdmin: boolean;
    /**
     * Actor identity carried into the subscriber so the
     * `connection_update` channel (and any future per-actor channel) can
     * fan out only the rows the caller owns. Set from the SSE auth
     * result — either `userId` (dashboard session or API key) or
     * `endUserId` (impersonation), never both.
     *
     * NOTE: these SSE routes do not support `Appstrate-User` impersonation
     * today — `validateSSEAuth` only ever resolves `userId` (the cookie
     * user or the API-key owner). The `endUserId` branch in the
     * `connection_update` filter (services/realtime.ts) is therefore
     * forward-looking: the channel is effectively dashboard-member-only,
     * and an end-user's connection rows (user_id NULL) reach no subscriber.
     */
    userId?: string;
    endUserId?: string;
    channels?: ReadonlySet<RealtimeChannel>;
  },
  verbose: boolean,
  onSubscribe?: (send: (evt: RealtimeEvent) => void) => void | Promise<void>,
) {
  // Tell a reverse proxy not to buffer this response. nginx buffers by default
  // (`proxy_buffering on`), which holds an SSE stream until a buffer fills or
  // the response ends — turning a live feed into a batch delivered at the end.
  // The header is nginx's documented opt-out and is ignored elsewhere. The chat
  // stream already carries it because the AI SDK sets it on its own responses;
  // this surface set nothing, so it was the one SSE endpoint unprotected
  // against a buffering proxy. Costs nothing when no proxy is in front.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    // Queue + signal so events written by PG NOTIFY callbacks are flushed
    // immediately via the stream's own async context (avoids Bun buffering).
    const pending: { event: string; data: string }[] = [];
    let wake: (() => void) | null = null;
    /** Set when this subscriber was dropped for being unable to keep up. */
    let droppedForBackpressure = false;

    const send = (evt: RealtimeEvent) => {
      if (droppedForBackpressure) return;
      // Backpressure policy — DROP THE SUBSCRIBER, don't grow the server.
      //
      // `pending` is filled synchronously from PG LISTEN callbacks and drained
      // by the stream's own async loop. A consumer that stops reading (dead
      // TCP peer, suspended tab, a client whose socket has a full send buffer)
      // stalls the drain while the producer keeps pushing, so an unbounded
      // queue turns one wedged client into unbounded API-process memory —
      // multiplied by every open stream.
      //
      // Trade-off, stated plainly: a dropped subscriber LOSES EVENTS. There is
      // no `Last-Event-ID` replay (see the resume note below), so the client's
      // reconnect lands on the live tail and the gap is permanent. That is
      // accepted deliberately: a client this far behind is already showing
      // stale state, the browser hooks reconnect automatically, and the
      // alternative (unbounded growth) degrades every other tenant on the
      // process. The cap is sized so only a genuinely stuck consumer trips it.
      if (pending.length >= MAX_PENDING_EVENTS) {
        droppedForBackpressure = true;
        pending.length = 0;
        removeSubscriber(subId);
        logger.warn("SSE subscriber dropped — outbound queue overflowed", {
          subId,
          cap: MAX_PENDING_EVENTS,
          runId: filter.runId,
          packageId: filter.packageId,
        });
        wake?.();
        return;
      }
      const payload = verbose ? evt.data : stripPayload(evt);
      pending.push({ event: evt.event, data: JSON.stringify(payload) });
      wake?.();
    };

    addSubscriber({ id: subId, filter, send });
    stream.onAbort(() => {
      removeSubscriber(subId);
      wake?.();
    });
    // Belt-and-braces teardown for half-open connections. Hono only wires its
    // `c.req.raw.signal` listener on Bun < 1.2 (`isOldBunVersion` in
    // hono/helper/streaming/sse), so on current Bun the ONLY abort path is
    // `responseReadable.cancel()` — which covers a clean disconnect but not a
    // peer that vanished without a FIN. When the runtime does abort the
    // request signal we tear down immediately instead of waiting for the
    // write deadline below. `stream.abort()` is idempotent.
    c.req.raw.signal.addEventListener("abort", () => stream.abort(), { once: true });
    void Promise.resolve(onSubscribe?.(send)).catch((err: unknown) => {
      logger.warn("SSE initial snapshot failed", {
        subId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // SSE event id, structured as `${subId}:${monotonic}` so it is
    // **globally unique across reconnects** even though the server keeps
    // no persisted log. Each new EventSource connection gets a fresh
    // `subId` (UUID-suffixed at the route level), so a client doing
    // `if (id === lastSeenId) skip` will never collide between streams.
    //
    // Resume semantics — what we DO and DO NOT do:
    //   • DO: emit a stable, per-frame id so browsers' built-in
    //     `Last-Event-ID` machinery can echo it on reconnect (browsers
    //     send the header automatically; the value lands in `c.req`).
    //   • DO: log the incoming `Last-Event-ID` for observability so a
    //     future server-side replay layer has a cheap-to-flip switch.
    //   • DO NOT: replay missed events. Realtime events live in PG
    //     NOTIFY land with no persisted log — a reconnect lands on the
    //     live tail, not on the gap. This is documented at the route
    //     level so SDK consumers know not to rely on resume.
    // HTML SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
    const lastEventIdHeader = c.req.header("Last-Event-ID");
    if (lastEventIdHeader !== undefined) {
      logger.debug(
        "SSE reconnect with Last-Event-ID — replay not implemented; resuming on live tail",
        { subId, lastEventIdHeader, runId: filter.runId, packageId: filter.packageId },
      );
    }
    let nextEventId = 0;
    const allocateId = (): string => `${subId}:${++nextEventId}`;

    /**
     * Write one frame with a deadline.
     *
     * Hono's `StreamingApi.write` swallows writer errors and never flips
     * `stream.aborted`, so a half-open peer surfaces here as a write that
     * simply never settles (the TransformStream stops being pulled once the
     * runtime's socket buffer fills). Racing a timer converts that silent
     * wedge into a normal teardown. Returns false when the deadline expired.
     */
    const writeFrame = async (msg: {
      event: string;
      data: string;
      id: string;
    }): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), WRITE_DEADLINE_MS);
      });
      try {
        return await Promise.race([stream.writeSSE(msg).then(() => true), deadline]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      // Immediate ping confirms the connection is alive.
      await writeFrame({ event: "ping", data: "", id: allocateId() });

      const PING_INTERVAL = 30_000;
      let lastWrite = Date.now();

      while (!stream.aborted && !droppedForBackpressure) {
        // Drain any queued events
        while (pending.length > 0) {
          const msg = pending.shift()!;
          if (!(await writeFrame({ ...msg, id: allocateId() }))) {
            logger.warn("SSE write deadline exceeded — closing stalled stream", {
              subId,
              deadlineMs: WRITE_DEADLINE_MS,
            });
            stream.abort();
            return;
          }
          lastWrite = Date.now();
        }
        if (droppedForBackpressure) break;

        // Wait for next event or ping timeout, whichever comes first
        const elapsed = Date.now() - lastWrite;
        const timeout = Math.max(0, PING_INTERVAL - elapsed);

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeout);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;

        // If no events were queued during the wait, send a keep-alive ping
        if (pending.length === 0 && !droppedForBackpressure) {
          if (!(await writeFrame({ event: "ping", data: "", id: allocateId() }))) {
            logger.warn("SSE keep-alive deadline exceeded — closing stalled stream", {
              subId,
              deadlineMs: WRITE_DEADLINE_MS,
            });
            stream.abort();
            return;
          }
          lastWrite = Date.now();
        }
      }
    } finally {
      // Single guaranteed unsubscribe point. `onAbort` covers clean
      // disconnects, but the loop can also exit via the backpressure drop or
      // the write deadline — leaving the subscriber registered would keep the
      // fan-out pushing into a queue nobody drains. `removeSubscriber` is a
      // `Map.delete`, so calling it twice is harmless.
      removeSubscriber(subId);
    }
  });
}

async function sendInitialRunSnapshot(
  runId: string,
  scope: { orgId: string; spaceId: string },
  send: (evt: RealtimeEvent) => void,
): Promise<void> {
  const [row] = await db
    .select({
      id: runs.id,
      packageId: runs.packageId,
      status: runs.status,
      userId: runs.userId,
      endUserId: runs.endUserId,
      orgId: runs.orgId,
      spaceId: runs.spaceId,
      scheduleId: runs.scheduleId,
      error: runs.error,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      duration: runs.duration,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, scope.orgId), eq(runs.spaceId, scope.spaceId)))
    .limit(1);

  if (!row) return;
  send({
    event: "run_update",
    data: {
      operation: "UPDATE",
      id: row.id,
      packageId: row.packageId,
      status: row.status,
      userId: row.userId,
      endUserId: row.endUserId,
      orgId: row.orgId,
      spaceId: row.spaceId,
      scheduleId: row.scheduleId,
      error: row.error,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      duration: row.duration,
    },
  });
}

export function createRealtimeRouter() {
  const router = new Hono();

  // GET /api/realtime/runs/:id — stream run status + log changes
  router.get("/runs/:id", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) throw unauthorized("Invalid session or org");

    const runId = c.req.param("id");
    const subId = `run-${runId}-${crypto.randomUUID().slice(0, 8)}`;
    const verbose = c.req.query("verbose") === "true";

    return openRealtimeStream(
      c,
      subId,
      {
        runId,
        orgId: validated.orgId,
        spaceId: validated.spaceId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
        channels: parseChannels(c.req.query("channels")),
      },
      verbose,
      (send) =>
        sendInitialRunSnapshot(runId, { orgId: validated.orgId, spaceId: validated.spaceId }, send),
    );
  });

  // GET /api/realtime/agents/:packageId/runs — stream run changes for an agent
  router.get("/agents/:packageId/runs", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) throw unauthorized("Invalid session or org");

    const packageId = c.req.param("packageId");
    const subId = `agent-${packageId}-${crypto.randomUUID().slice(0, 8)}`;
    const verbose = c.req.query("verbose") === "true";

    return openRealtimeStream(
      c,
      subId,
      {
        packageId,
        orgId: validated.orgId,
        spaceId: validated.spaceId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
        channels: parseChannels(c.req.query("channels")),
      },
      verbose,
    );
  });

  // GET /api/realtime/runs — stream all run changes (for agent list)
  router.get("/runs", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) throw unauthorized("Invalid session or org");

    const subId = `all-run-${crypto.randomUUID().slice(0, 8)}`;
    const verbose = c.req.query("verbose") === "true";

    return openRealtimeStream(
      c,
      subId,
      {
        orgId: validated.orgId,
        spaceId: validated.spaceId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
        channels: parseChannels(c.req.query("channels")),
      },
      verbose,
    );
  });

  return router;
}
