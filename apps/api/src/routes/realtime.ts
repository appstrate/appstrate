import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { auth } from "../lib/auth.ts";
import { organizationMembers } from "@appstrate/db/schema";
import { addSubscriber, removeSubscriber } from "../services/realtime.ts";
import type { RealtimeEvent } from "../services/realtime.ts";
import { unauthorized } from "../lib/errors.ts";
import { validateApiKey } from "../services/api-keys.ts";

/** Strip large user-content fields from SSE payloads for non-verbose consumers. */
function stripPayload(evt: RealtimeEvent): Record<string, unknown> {
  if (evt.event === "execution_update") {
    const { result: _result, ...rest } = evt.data;
    return rest;
  }
  if (evt.event === "execution_log") {
    const { data: _data, ...rest } = evt.data;
    return rest;
  }
  return evt.data;
}

interface SSEAuthResult {
  userId: string;
  orgId: string;
  role: string;
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

    return { userId: keyInfo.userId, orgId: keyInfo.orgId, role: "admin" };
  }

  // 2. Fallback: cookie session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return null;

  const orgId = c.req.query("orgId");
  if (!orgId) return null;

  // Verify org membership
  const rows = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, session.user.id)),
    )
    .limit(1);

  if (!rows[0]) return null;

  return { userId: session.user.id, orgId, role: rows[0].role };
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

export function createRealtimeRouter() {
  const router = new Hono();

  // GET /api/realtime/executions/:id — stream execution status + log changes
  router.get("/executions/:id", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) {
      throw unauthorized("Invalid session or org");
    }

    const executionId = c.req.param("id");
    const subId = `exec-${executionId}-${crypto.randomUUID().slice(0, 8)}`;

    const verbose = c.req.query("verbose") === "true";

    return streamSSE(c, async (stream) => {
      const send = (evt: RealtimeEvent) => {
        const payload = verbose ? evt.data : stripPayload(evt);
        stream.writeSSE({ event: evt.event, data: JSON.stringify(payload) }).catch(() => {});
      };

      addSubscriber({
        id: subId,
        filter: { executionId, orgId: validated.orgId, isAdmin: isAdminRole(validated.role) },
        send,
      });

      stream.onAbort(() => {
        removeSubscriber(subId);
      });

      // Keep alive with periodic pings
      while (true) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(30000);
      }
    });
  });

  // GET /api/realtime/flows/:packageId/executions — stream execution changes for a flow
  router.get("/flows/:packageId/executions", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) {
      throw unauthorized("Invalid session or org");
    }

    const packageId = c.req.param("packageId");
    const subId = `flow-${packageId}-${crypto.randomUUID().slice(0, 8)}`;

    const verbose = c.req.query("verbose") === "true";

    return streamSSE(c, async (stream) => {
      const send = (evt: RealtimeEvent) => {
        const payload = verbose ? evt.data : stripPayload(evt);
        stream.writeSSE({ event: evt.event, data: JSON.stringify(payload) }).catch(() => {});
      };

      addSubscriber({
        id: subId,
        filter: { packageId, orgId: validated.orgId, isAdmin: isAdminRole(validated.role) },
        send,
      });

      stream.onAbort(() => {
        removeSubscriber(subId);
      });

      while (true) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(30000);
      }
    });
  });

  // GET /api/realtime/executions — stream all execution changes (for flow list)
  router.get("/executions", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) {
      throw unauthorized("Invalid session or org");
    }

    const subId = `all-exec-${crypto.randomUUID().slice(0, 8)}`;

    const verbose = c.req.query("verbose") === "true";

    return streamSSE(c, async (stream) => {
      const send = (evt: RealtimeEvent) => {
        const payload = verbose ? evt.data : stripPayload(evt);
        stream.writeSSE({ event: evt.event, data: JSON.stringify(payload) }).catch(() => {});
      };

      addSubscriber({
        id: subId,
        filter: { orgId: validated.orgId, isAdmin: isAdminRole(validated.role) },
        send,
      });

      stream.onAbort(() => {
        removeSubscriber(subId);
      });

      while (true) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(30000);
      }
    });
  });

  return router;
}
