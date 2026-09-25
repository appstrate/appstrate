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
import { API_KEY_PREFIX, validateApiKey } from "../services/api-keys.ts";
import { getOrgMember } from "../services/organizations.ts";
import { ceilingAllows, effectivePermissions, type Permission } from "../lib/permissions.ts";
import { resolveSpaceRole, type SpaceMemberRow } from "../lib/space-role.ts";
import { loadSpaceAccess, type SpaceContextRow } from "../lib/space-lookup.ts";
import {
  callerPersonalOwnerId,
  effectiveInSpace,
  orgHalfFor,
  personaFor,
  personaSpaceMember,
  validateViewAs,
} from "../lib/view-as.ts";
import { principalGrants } from "../lib/principal-permissions.ts";
import { canReadEveryRun, ownsRun } from "../lib/run-visibility.ts";
import {
  canReadRuns,
  reportPermissionDenial,
  VIEW_AS_ACTIVE_HEADER,
  VIEW_AS_HEADER,
  VIEW_AS_QUERY,
} from "@appstrate/core/permissions";
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
 *   • parameter absent            → `undefined` = subscribe to every channel
 *     the caller may receive (`subscribedChannels`).
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

/**
 * What a caller must hold to receive each channel. A run channel carries run
 * rows, so it needs a run read in the streamed space (RBAC spec §3.4); a
 * per-actor channel carries only the caller's own rows, which only a delegated
 * credential's ceiling takes away (§7.1). Total over the enum, so a new channel
 * cannot ship without a rule.
 */
const CHANNEL_REQUIREMENTS: Record<RealtimeChannel, "run-read" | { ceiling: Permission }> = {
  run_update: "run-read",
  run_log: "run-read",
  run_metric: "run-read",
  connection_update: { ceiling: "integrations:read" },
  // Declared by `@appstrate/module-chat`, whose resource merge this package does not see.
  chat_session_update: { ceiling: "chat:read" as Permission },
};

/** The requested channels — every channel when none is requested — this caller may receive. */
function subscribedChannels(
  c: Context<AppEnv>,
  requested: ReadonlySet<RealtimeChannel> | undefined,
  readsRuns: boolean,
): ReadonlySet<RealtimeChannel> {
  return new Set(
    [...(requested ?? REALTIME_CHANNELS)].filter((channel) => {
      const rule = CHANNEL_REQUIREMENTS[channel];
      return rule === "run-read" ? readsRuns : ceilingAllows(c, rule.ceiling);
    }),
  );
}

interface SSEAuthResult {
  userId: string;
  orgId: string;
  /**
   * `runs:read` or `runs:read-all` in the streamed space — the disjunction
   * `requireRunsRead` applies on HTTP. It opens the run channels, and the two
   * run-only streams; the per-actor channels need none.
   */
  readsRuns: boolean;
  /**
   * Gates debug-level `run_log` events only (services/realtime.ts). Read from
   * `runs:delete`: every run-channel reader holds a run read, so that cannot discriminate.
   */
  canReadDebugLogs: boolean;
  /**
   * `runs:read-all` in the streamed space. `runs:read` alone means "the runs I
   * launched"; this is what widens the three run channels to the whole space
   * (RBAC spec §3.4).
   */
  canReadEveryRun: boolean;
  spaceId: string;
}

/**
 * SSE routes skip the auth pipeline (`skipAuth` matches `/api/realtime/`), so
 * the PRINCIPAL's permission set in the streamed space is resolved here — not
 * the API key's ceiling, which the caller intersects afterwards. `null` when
 * the principal has no role in that space. `memberRow` is the persona's overlay
 * under a role preview, so it is passed in rather than loaded.
 *
 * The org half folds in `principalGrants` exactly as the HTTP pipeline does, so
 * the stream answers the same caller every other transport does.
 */
async function resolveSpaceGrants(
  c: Context<AppEnv>,
  orgId: string,
  realRole: OrgRole,
  space: SpaceContextRow,
  memberRow: SpaceMemberRow | null,
  callerId: string | null,
): Promise<ReadonlySet<string> | null> {
  const ref = resolveSpaceRole(
    personaFor(c, orgId)?.orgRole ?? realRole,
    space,
    memberRow,
    callerId,
  );
  if (!ref) return null;
  return effectiveInSpace(
    c,
    ref,
    orgHalfFor(c, orgId, realRole, await principalGrants(c, orgId)).orgPermissions,
  );
}

/**
 * Validate auth for SSE endpoints.
 *
 * Supports two auth methods:
 *  1. API key via `?token=apst_...` query param (EventSource can't send headers)
 *  2. Cookie session (existing behavior)
 *
 * Org context: `?orgId=` query param (cookie auth only — API key already resolves org).
 *
 * Both branches resolve permissions as the HTTP pipeline does (key: scopes ∩
 * creator's live authority in the key's space; session: org ∪ space), never
 * inherited admin, and report whether that set reads runs. What a caller
 * without a run read may still open is each route's call, not this one's.
 *
 * ROLE PREVIEW arrives as `?view_as=` (same grammar and validation as
 * `X-View-As`): an `EventSource` cannot send a header, and the header guard
 * never runs for these pipeline-exempt routes.
 */
async function validateSSEAuth(c: Context<AppEnv>): Promise<SSEAuthResult | null> {
  const viewAsRaw = c.req.query(VIEW_AS_QUERY);
  if (c.req.header(VIEW_AS_HEADER) !== undefined) {
    // Refuse, never ignore: a client that believes it is previewing must not get real authority.
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
  if (token?.startsWith(API_KEY_PREFIX)) {
    if (viewAsRaw !== undefined) {
      // Same refusal as the HTTP transport guard: a key has no session to narrow.
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

    // `spaceId` comes off the `api_keys` row; `loadSpaceAccess` shape-checks it
    // and reads it with the creator's row in one statement (RBAC spec §4.4).
    const access = await loadSpaceAccess(keyInfo.spaceId, keyInfo.orgId, keyInfo.userId);
    if (!access) return null;

    // Creator's LIVE authority in the key's space (RBAC spec §7.1).
    const grants = await resolveSpaceGrants(
      c,
      keyInfo.orgId,
      keyInfo.creatorRole,
      access.space,
      access.member,
      // A key never reaches a personal space, not even its creator's: it is
      // pinned to one space and carries their authority, not their privacy
      // (RBAC spec §3.6). Passed as `null` rather than left to a context key
      // this pipeline-exempt route does not set.
      null,
    );
    if (!grants) {
      throw forbidden("The key's creator is not a member of the key's space");
    }
    // On the context too, so ceiling-capped reads below answer as on HTTP.
    const scopeCeiling = new Set<string>(keyInfo.scopes);
    c.set("scopeCeiling", scopeCeiling);
    const permissions = effectivePermissions({ orgPermissions: grants, scopeCeiling });

    return {
      userId: keyInfo.userId,
      orgId: keyInfo.orgId,
      // From the ceilinged set, not `grants`: the key's scopes bound whether the
      // stream carries runs at all, which of them, and their debug logs.
      readsRuns: canReadRuns((p) => permissions.has(p)),
      canReadDebugLogs: permissions.has("runs:delete"),
      canReadEveryRun: canReadEveryRun(permissions),
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

  // Validate space belongs to org. A 404, not the `null` that becomes a 401
  // below: paired with the 404 the visibility split raises further down, a 401
  // here would tell the caller which `spc_` ids exist in the org — and the SPA
  // puts that id in the query string (RBAC spec §3.6). One statement with the
  // user's row (§4.4); none under a preview — any `viewAs` value yields a persona or throws.
  const access = await loadSpaceAccess(
    spaceId,
    orgId,
    viewAsRaw !== undefined ? null : session.user.id,
  );
  if (!access) throw notFound(`Space '${spaceId}' not found in this organization`);
  const { space } = access;

  const role = member.role;
  // Set before the persona is judged: `reportPermissionDenial` names the actor from the context.
  c.set("user", {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
  });
  c.set("orgId", orgId);
  c.set("orgRole", role);
  // The denial audit names the transport; `callerPersonalOwnerId` reads the kind.
  c.set("authMethod", "session");
  c.set("principalKind", "user");

  const persona = await validateViewAs({
    raw: viewAsRaw,
    orgId,
    realOrgRole: role,
    onDenial: (required) => reportPermissionDenial(c, required),
  });
  // Set now so a refusal below also carries the marker (`errorHandler` stamps it).
  if (persona) c.set("viewAs", persona);

  // Same as `applySpacePermissions`: being in the org is not being in the space.
  const grants = await resolveSpaceGrants(
    c,
    orgId,
    role,
    space,
    persona ? personaSpaceMember(persona, space.id) : access.member,
    // The personal-space identity, not simply the session user: under a role
    // preview it is `null`, so the previewer's OWN personal space stops being
    // streamable through a persona that has none (RBAC spec §3.6). The context
    // keys it reads — `user`, `principalKind`, `viewAs` — are all set above.
    callerPersonalOwnerId(c, orgId),
  );
  if (!grants) {
    // Same 403 / 404 split as `applySpacePermissions`, not a 401 for an authenticated session.
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
  // A session has no ceiling, so its effective set IS `grants`.
  return {
    userId: session.user.id,
    orgId,
    readsRuns: canReadRuns((p) => grants.has(p)),
    canReadDebugLogs: grants.has("runs:delete"),
    canReadEveryRun: canReadEveryRun(grants),
    spaceId,
  };
}

/**
 * The single-run and per-agent streams exist to carry runs: refused outright
 * without a run read, rather than opened onto the caller's own rows alone.
 */
function requireRunRead(validated: SSEAuthResult): void {
  if (!validated.readsRuns) {
    throw forbidden(
      "Caller does not have the 'runs:read' or 'runs:read-all' permission in this space",
    );
  }
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
    /** Caller's `runs:read-all` grant — see {@link SSEAuthResult.canReadEveryRun}. */
    readAll: boolean;
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
  // Same marker the HTTP pipeline stamps; here so all three streams carry it.
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

/**
 * The run row behind a per-run stream: the visibility gate reads it before
 * subscribing, {@link sendInitialRunSnapshot} reads it again after — which is
 * the invariant documented there, not an accident to be optimised away.
 */
async function loadRunForStream(runId: string, scope: { orgId: string; spaceId: string }) {
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
  return row ?? null;
}

/**
 * The stream's first frame. Deliberately read AFTER the subscriber is
 * registered — a row read before that could be superseded by an update the
 * subscriber was not yet there to hear, and the stream would sit on a status
 * that has already moved on.
 */
async function sendInitialRunSnapshot(
  runId: string,
  scope: { orgId: string; spaceId: string },
  send: (evt: RealtimeEvent) => void,
): Promise<void> {
  const row = await loadRunForStream(runId, scope);
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

  // These streams are pipeline-exempt and mount no guard at all —
  // `validateSSEAuth` resolves the principal, its grants in the space and the
  // run-read disjunction from inside the handler; each route applies it.

  // GET /api/realtime/runs/:id — stream run status + log changes
  router.get("/runs/:id", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) throw unauthorized("Invalid session or org");
    requireRunRead(validated);

    const runId = c.req.param("id")!;
    const subId = `run-${runId}-${crypto.randomUUID().slice(0, 8)}`;
    const verbose = c.req.query("verbose") === "true";

    // Refuse the subscription instead of filtering every frame of it, with the
    // same 404 the HTTP run routes answer: a run the caller may not read must
    // be indistinguishable from one that does not exist, on this transport
    // too. A run id with no row is NOT refused — the SPA opens this stream the
    // moment it fires a launch, before the row is necessarily visible here —
    // and such a stream simply carries no snapshot.
    const row = await loadRunForStream(runId, {
      orgId: validated.orgId,
      spaceId: validated.spaceId,
    });
    if (
      row &&
      !validated.canReadEveryRun &&
      !ownsRun({ type: "user", id: validated.userId }, row)
    ) {
      throw notFound("Run not found");
    }

    return openRealtimeStream(
      c,
      subId,
      {
        runId,
        orgId: validated.orgId,
        spaceId: validated.spaceId,
        isAdmin: validated.canReadDebugLogs,
        readAll: validated.canReadEveryRun,
        userId: validated.userId,
        channels: subscribedChannels(
          c,
          parseChannels(c.req.query("channels")),
          validated.readsRuns,
        ),
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
    requireRunRead(validated);

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
        readAll: validated.canReadEveryRun,
        userId: validated.userId,
        channels: subscribedChannels(
          c,
          parseChannels(c.req.query("channels")),
          validated.readsRuns,
        ),
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
    // A multiplex, not a run stream: a caller without a run read keeps the
    // per-actor channels. Refused only when no requested channel is left, so
    // a stream is never opened dead.
    const channels = subscribedChannels(
      c,
      parseChannels(c.req.query("channels")),
      validated.readsRuns,
    );
    if (channels.size === 0) {
      throw forbidden("Caller may receive none of the requested channels in this space");
    }

    return openRealtimeStream(
      c,
      subId,
      {
        orgId: validated.orgId,
        spaceId: validated.spaceId,
        isAdmin: validated.canReadDebugLogs,
        readAll: validated.canReadEveryRun,
        userId: validated.userId,
        channels,
      },
      verbose,
    );
  });

  return router;
}
