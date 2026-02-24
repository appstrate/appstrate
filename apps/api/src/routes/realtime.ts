import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { auth } from "../lib/auth.ts";
import { organizationMembers } from "@appstrate/db/schema";
import { addSubscriber, removeSubscriber } from "../services/realtime.ts";
import type { RealtimeEvent } from "../services/realtime.ts";

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

/**
 * Validate session + org membership for SSE endpoints.
 * EventSource can't send custom headers, so:
 *  - Auth: via Better Auth session cookie (sent automatically with withCredentials)
 *  - Org: via ?orgId= query parameter
 */
async function validateSSEAuth(c: {
  req: { raw: Request; query: (key: string) => string | undefined };
}): Promise<{ userId: string; orgId: string } | null> {
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

  return { userId: session.user.id, orgId };
}

export function createRealtimeRouter() {
  const router = new Hono();

  // GET /api/realtime/executions/:id — stream execution status + log changes
  router.get("/executions/:id", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid session or org" }, 401);
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
        filter: { executionId, orgId: validated.orgId },
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

  // GET /api/realtime/flows/:flowId/executions — stream execution changes for a flow
  router.get("/flows/:flowId/executions", async (c) => {
    const validated = await validateSSEAuth(c);
    if (!validated) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid session or org" }, 401);
    }

    const flowId = c.req.param("flowId");
    const subId = `flow-${flowId}-${crypto.randomUUID().slice(0, 8)}`;

    const verbose = c.req.query("verbose") === "true";

    return streamSSE(c, async (stream) => {
      const send = (evt: RealtimeEvent) => {
        const payload = verbose ? evt.data : stripPayload(evt);
        stream.writeSSE({ event: evt.event, data: JSON.stringify(payload) }).catch(() => {});
      };

      addSubscriber({
        id: subId,
        filter: { flowId, orgId: validated.orgId },
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
      return c.json({ error: "UNAUTHORIZED", message: "Invalid session or org" }, 401);
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
        filter: { orgId: validated.orgId },
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
