// SPDX-License-Identifier: Apache-2.0

/**
 * Realtime change signal for chat sessions.
 *
 * Publishes a `chat_session_update` NOTIFY whenever a session row changes so
 * the platform's single SSE fan-out (apps/api/src/services/realtime.ts) pushes
 * it to the owner's connected clients — the conversation list refetches instead
 * of polling, and read-state syncs across devices instantly.
 *
 * Signal-only payload (owner identity for fan-out filtering, no session data):
 * consumers refetch the list, keeping the DTO single-sourced in routes.ts.
 * Fire-and-forget: a lost signal only delays freshness until the UI's slow
 * safety-net refetch, so a notify failure must never fail the mutation that
 * triggered it.
 */

import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { logger } from "./logger.ts";

/**
 * Fire-and-forget by construction, not by call-site convention.
 *
 * It used to return a promise that could not reject (the `catch` below is
 * total), which left every caller a choice it had no basis to make: six awaited
 * a round trip whose result they discarded, and one detached with a paragraph
 * explaining why — reasoning that applied verbatim to the other six. A function
 * whose contract is "best-effort, a lost signal delays a refetch" should not
 * hand out a promise for callers to argue about.
 *
 * The cost of never awaiting is stated and accepted upstream: a signal lost to
 * a process exit delays a sidebar refetch until the client's own safety net. No
 * data depends on it.
 */
export function notifySessionUpdate(sessionId: string, orgId: string, userId: string): void {
  const payload = JSON.stringify({ session_id: sessionId, org_id: orgId, user_id: userId });
  void db
    .execute(sql`SELECT pg_notify('chat_session_update', ${payload})`)
    .catch((err: unknown) => {
      logger.warn("chat_session_update notify failed", { sessionId, error: String(err) });
    });
}
