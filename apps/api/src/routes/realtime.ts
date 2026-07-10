// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import { organizationMembers, runs } from "@appstrate/db/schema";
import { scopedWhere } from "../lib/db-helpers.ts";
import { addSubscriber, removeSubscriber } from "../services/realtime.ts";
import type { RealtimeEvent } from "../services/realtime.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { validateApiKey } from "../services/api-keys.ts";
import { resolveApiKeyPermissions } from "../lib/permissions.ts";
import { validateApplicationInOrg } from "../middleware/app-context.ts";
import { logger } from "../lib/logger.ts";
import type { OrgRole } from "../types/index.ts";

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
  applicationId: string;
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

    return {
      userId: keyInfo.userId,
      orgId: keyInfo.orgId,
      role: keyInfo.creatorRole,
      isAdmin: isAdminRole(keyInfo.creatorRole),
      applicationId: keyInfo.applicationId,
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

  const applicationId = c.req.query("applicationId");
  if (!applicationId) return null;

  // Validate application belongs to org
  const app = await validateApplicationInOrg(applicationId, orgId);
  if (!app) return null;

  return {
    userId: session.user.id,
    orgId,
    role: rows[0].role,
    isAdmin: isAdminRole(rows[0].role),
    applicationId,
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
    applicationId: string;
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
  },
  verbose: boolean,
  onSubscribe?: (send: (evt: RealtimeEvent) => void) => void | Promise<void>,
) {
  return streamSSE(c, async (stream) => {
    // Queue + signal so events written by PG NOTIFY callbacks are flushed
    // immediately via the stream's own async context (avoids Bun buffering).
    const pending: { event: string; data: string }[] = [];
    let wake: (() => void) | null = null;

    const send = (evt: RealtimeEvent) => {
      const payload = verbose ? evt.data : stripPayload(evt);
      pending.push({ event: evt.event, data: JSON.stringify(payload) });
      wake?.();
    };

    addSubscriber({ id: subId, filter, send });
    stream.onAbort(() => {
      removeSubscriber(subId);
      wake?.();
    });
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

    // Immediate ping confirms the connection is alive.
    await stream.writeSSE({ event: "ping", data: "", id: allocateId() });

    const PING_INTERVAL = 30_000;
    let lastWrite = Date.now();

    while (!stream.aborted) {
      // Drain any queued events
      while (pending.length > 0) {
        const msg = pending.shift()!;
        await stream.writeSSE({ ...msg, id: allocateId() });
        lastWrite = Date.now();
      }

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
      if (pending.length === 0) {
        await stream.writeSSE({ event: "ping", data: "", id: allocateId() });
        lastWrite = Date.now();
      }
    }
  });
}

async function sendInitialRunSnapshot(
  runId: string,
  scope: { orgId: string; applicationId: string },
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
      applicationId: runs.applicationId,
      scheduleId: runs.scheduleId,
      error: runs.error,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      duration: runs.duration,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, scope.orgId),
        eq(runs.applicationId, scope.applicationId),
      ),
    )
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
      applicationId: row.applicationId,
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
        applicationId: validated.applicationId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
      },
      verbose,
      (send) =>
        sendInitialRunSnapshot(
          runId,
          { orgId: validated.orgId, applicationId: validated.applicationId },
          send,
        ),
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
        applicationId: validated.applicationId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
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
        applicationId: validated.applicationId,
        isAdmin: validated.isAdmin,
        userId: validated.userId,
      },
      verbose,
    );
  });

  return router;
}
