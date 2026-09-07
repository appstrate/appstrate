// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import { runs } from "@appstrate/db/schema";
import { addSubscriber, removeSubscriber, REALTIME_CHANNELS } from "../services/realtime.ts";
import type { RealtimeEvent, RealtimeChannel } from "../services/realtime.ts";
import { ApiError, forbidden, notFound, unauthorized } from "../lib/errors.ts";
import { validateApiKey } from "../services/api-keys.ts";
import { getOrgMember } from "../services/organizations.ts";
import { effectivePermissions } from "../lib/permissions.ts";
import {
  loadSpaceMember,
  resolveSpaceRole,
  spacePermissions,
  type SpaceMemberRow,
} from "../lib/space-role.ts";
import { validateSpaceInOrg, type SpaceContextRow } from "../lib/space-lookup.ts";
import { orgHalfFor, personaFor, personaSpaceMember, validateViewAs } from "../lib/view-as.ts";
import {
  reportPermissionDenial,
  VIEW_AS_ACTIVE_HEADER,
  VIEW_AS_HEADER,
  VIEW_AS_QUERY,
} from "@appstrate/core/permissions";
import { assertSpaceId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import type { AppEnv, OrgRole } from "../types/index.ts";

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
  /**
   * Whether the subscriber sees debug-level `run_log` events
   * (services/realtime.ts) — the only thing this flag gates. Read from
   * `runs:delete`, the admin-grade action of the run family: `runs:read`
   * opens the stream for everyone, so it cannot discriminate here.
   */
  canReadDebugLogs: boolean;
  spaceId: string;
}

/**
 * These SSE routes are exempt from the auth pipeline (`skipAuth` matches
 * `/api/realtime/`), so the principal's permission set is resolved here rather
 * than read from the context. It is the PRINCIPAL's set in the streamed space,
 * not the API key's ceiling: debug-log visibility follows the principal behind
 * the stream, and narrowing it to the key's scopes would hide debug frames
 * from a `runs:read`-only key that is allowed to see them today.
 *
 * `null` when the principal has no role in that space — a guest without a row,
 * or a member of a closed/private space they were never added to. The caller
 * turns that into a denied stream.
 *
 * `memberRow` is passed in rather than loaded here because under a role preview
 * it is the persona's overlay, not a row this user has; `persona` then supplies
 * the org half's real set, exactly as the HTTP pipeline does.
 */
function resolveSpaceGrants(
  c: Context<AppEnv>,
  orgId: string,
  realRole: OrgRole,
  space: SpaceContextRow,
  memberRow: SpaceMemberRow | null,
): ReadonlySet<string> | null {
  const ref = resolveSpaceRole(personaFor(c, orgId)?.orgRole ?? realRole, space, memberRow);
  if (!ref) return null;
  // `orgHalfFor` applies the persona to the org half; the space half is already
  // the persona's, resolved from its overlay above.
  return new Set<string>([
    ...orgHalfFor(c, orgId, realRole).orgPermissions,
    ...spacePermissions(ref),
  ]);
}

/**
 * Validate auth for SSE endpoints.
 *
 * Supports two auth methods:
 *  1. API key via `?token=ask_...` query param (EventSource can't send headers)
 *  2. Cookie session (existing behavior)
 *
 * Org context: `?orgId=` query param (cookie auth only — API key already resolves org).
 *
 * Both branches go through the same canonical resolution as the HTTP pipeline
 * (for a key: scopes ∩ the creator's live authority in the key's space; for a
 * session: the org ∪ space union) and both must carry `runs:read` to open any
 * run stream. A caller that reached the space without that permission is
 * rejected with 403 instead of silently inheriting admin.
 *
 * ROLE PREVIEW: these routes are exempt from the auth pipeline, so the
 * `X-View-As` guard never runs for them — and the browser client is an
 * `EventSource`, which cannot send a header at all. The persona therefore
 * arrives as `?view_as=`, in the same grammar, and goes through the same
 * validation. A stream opened under a persona is the persona's stream: it sees
 * what that role would see, and stops where that role would stop.
 */
async function validateSSEAuth(c: Context<AppEnv>): Promise<SSEAuthResult | null> {
  const viewAsRaw = c.req.query(VIEW_AS_QUERY);
  if (c.req.header(VIEW_AS_HEADER) !== undefined) {
    // These routes skip the auth pipeline, so the header's own guard never runs
    // for them. Refusing beats ignoring: a client that believes it is previewing
    // must not be handed a stream of the caller's real authority.
    throw new ApiError({
      status: 400,
      code: "invalid_view_as",
      title: "Invalid View-As Header",
      detail: `Server-Sent-Events routes take the role preview as the \`${VIEW_AS_QUERY}\` query parameter, not as a header.`,
      param: VIEW_AS_HEADER,
    });
  }

  // 1. Try API key auth via ?token= query param
  const token = c.req.query("token");
  if (token?.startsWith("ask_")) {
    if (viewAsRaw !== undefined) {
      // Same refusal the HTTP transport guard gives: a key carries a ceiling of
      // its own and no session to narrow.
      throw new ApiError({
        status: 400,
        code: "view_as_unsupported",
        title: "View-As Not Supported",
        detail: `${VIEW_AS_QUERY} is only supported for a user session, not for api_key authentication.`,
        param: VIEW_AS_QUERY,
      });
    }
    const keyInfo = await validateApiKey(token);
    if (!keyInfo) return null;

    // The key's `spaceId` comes straight off the `api_keys` row, so this is
    // the shape check for that path: `assertSpaceId` refuses anything that is
    // not a canonical `spc_` id before it reaches the stream. The row is then
    // loaded because the space's visibility and default role are what decide
    // the creator's membership.
    assertSpaceId(keyInfo.spaceId);
    const keySpace = await validateSpaceInOrg(keyInfo.spaceId, keyInfo.orgId);
    if (!keySpace) return null;

    // The creator's live authority in the key's space (RBAC spec §7.1): a
    // creator who lost the space leaves the key with nothing to read here.
    const grants = resolveSpaceGrants(
      c,
      keyInfo.orgId,
      keyInfo.creatorRole,
      keySpace,
      await loadSpaceMember(keySpace.id, keyInfo.userId),
    );
    if (!grants) {
      throw forbidden("The key's creator is not a member of the key's space");
    }
    const permissions = effectivePermissions({
      orgPermissions: grants,
      scopeCeiling: new Set(keyInfo.scopes),
    });
    if (!permissions.has("runs:read")) {
      throw forbidden("API key does not have the 'runs:read' scope");
    }

    return {
      userId: keyInfo.userId,
      orgId: keyInfo.orgId,
      // From the CEILINGED set, not from `grants`: a key whose scopes stop at
      // `runs:read` must not stream verbose logs just because its creator could.
      canReadDebugLogs: permissions.has("runs:delete"),
      spaceId: keyInfo.spaceId,
    };
  }

  // 2. Fallback: cookie session
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return null;

  const orgId = c.req.query("orgId");
  if (!orgId) return null;

  const member = await getOrgMember(orgId, session.user.id);
  if (!member) return null;

  const spaceId = c.req.query("spaceId");
  if (!spaceId) return null;

  // Validate space belongs to org
  const space = await validateSpaceInOrg(spaceId, orgId);
  if (!space) return null;

  const role = member.role;
  // Published before the persona is judged: `reportPermissionDenial` reads them
  // off the context, and outside the pipeline nothing else puts them there — a
  // denial record naming no actor is not a record.
  c.set("user", {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
  });
  c.set("orgId", orgId);
  c.set("orgRole", role);

  const persona = await validateViewAs({
    raw: viewAsRaw,
    orgId,
    realOrgRole: role,
    onDenial: (required) => reportPermissionDenial(c, required),
  });
  // Published before the stream opens so the marker reaches BOTH halves: the
  // success path below reads it, and a refusal raised from here leaves through
  // `errorHandler`, which stamps the marker on the problem response.
  if (persona) c.set("viewAs", persona);

  // Same membership resolution the HTTP pipeline applies (`applySpacePermissions`):
  // being in the org is not being in the space.
  const grants = resolveSpaceGrants(
    c,
    orgId,
    role,
    space,
    persona
      ? personaSpaceMember(persona, space.id)
      : await loadSpaceMember(space.id, session.user.id),
  );
  if (!grants) {
    // `null` here is exactly what `applySpacePermissions` turns into 403 / 404
    // on the HTTP pipeline; the stream answers the same, so a member-less
    // caller is not told to log in again for an authenticated session that is
    // simply outside the space.
    if (space.visibility === "private") {
      throw notFound(`Space '${space.id}' not found in this organization`);
    }
    throw new ApiError({
      status: 403,
      code: "not_a_space_member",
      title: "Not a Space Member",
      detail: `You are not a member of space '${space.id}'`,
    });
  }
  // Same floor as the API-key branch above. A cookie session carries no scope
  // ceiling, so its effective set IS `grants` — a custom space role without
  // `runs:read` must not open a run stream just because it reached the space.
  if (!grants.has("runs:read")) {
    throw forbidden("Caller does not have the 'runs:read' permission in this space");
  }

  return {
    userId: session.user.id,
    orgId,
    canReadDebugLogs: grants.has("runs:delete"),
    spaceId,
  };
}

/** Open an SSE stream with a subscriber filter, verbose toggle, and ping keep-alive. */
function openRealtimeStream(
  c: Context<AppEnv>,
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
  // Same marker the HTTP pipeline stamps, for the same reason: a client must be
  // able to tell a stream (or a refusal) that is the persona's from one that is
  // its own. Set here rather than per route so all three streams carry it.
  if (c.get("viewAs")) c.header(VIEW_AS_ACTIVE_HEADER, "1");
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
  const router = new Hono<AppEnv>();

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
        isAdmin: validated.canReadDebugLogs,
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
        isAdmin: validated.canReadDebugLogs,
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
        isAdmin: validated.canReadDebugLogs,
        userId: validated.userId,
        channels: parseChannels(c.req.query("channels")),
      },
      verbose,
    );
  });

  return router;
}
