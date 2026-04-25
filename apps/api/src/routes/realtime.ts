// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import { organizationMembers } from "@appstrate/db/schema";
import { scopedWhere } from "../lib/db-helpers.ts";
import { addSubscriber, removeSubscriber } from "../services/realtime.ts";
import type { RealtimeEvent } from "../services/realtime.ts";
import { unauthorized } from "../lib/errors.ts";
import { validateApiKey } from "../services/api-keys.ts";
import { validateApplicationInOrg } from "../middleware/app-context.ts";
import type { OrgRole } from "../types/index.ts";

/** Strip large user-content fields from SSE payloads for non-verbose consumers. */
function stripPayload(evt: RealtimeEvent): Record<string, unknown> {
  if (evt.event === "run_update") {
    const { result: _result, ...rest } = evt.data;
    return rest;
  }
  if (evt.event === "run_log") {
    const { data: _data, ...rest } = evt.data;
    return rest;
  }
  return evt.data;
}

interface SSEAuthResult {
  userId: string;
  orgId: string;
  role: OrgRole;
  applicationId: string;
}

/**
 * Validate auth for SSE endpoints.
 *
 * Supports two auth methods:
 *  1. API key via `?token=ask_...` query param (EventSource can't send headers)
 *  2. Cookie session (existing behavior)
 *
 * Org context: `?orgId=` query param (cookie auth only — API key already resolves org).
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

    return {
      userId: keyInfo.userId,
      orgId: keyInfo.orgId,
      role: "admin",
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

  const applicationId = c.req.query("appId");
  if (!applicationId) return null;

  // Validate application belongs to org
  const app = await validateApplicationInOrg(applicationId, orgId);
  if (!app) return null;

  return {
    userId: session.user.id,
    orgId,
    role: rows[0].role,
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
  },
  verbose: boolean,
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

    // Per-stream monotonic event id. Resumable from `Last-Event-ID` only
    // within the same subscriber instance — events live in PG NOTIFY land,
    // not in a replayable log, so reconnect resumes the live tail rather
    // than replaying gaps. The id still lets browsers/EventSource clients
    // correlate frames and avoid duplicate processing across reconnects.
    // HTML SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
    let nextEventId = 0;
    const allocateId = (): string => String(++nextEventId);

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
        isAdmin: true,
      },
      verbose,
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
        isAdmin: true,
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
        isAdmin: true,
      },
      verbose,
    );
  });

  return router;
}
