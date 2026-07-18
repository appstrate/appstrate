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

export async function notifySessionUpdate(
  sessionId: string,
  orgId: string,
  userId: string,
): Promise<void> {
  const payload = JSON.stringify({ session_id: sessionId, org_id: orgId, user_id: userId });
  try {
    await db.execute(sql`SELECT pg_notify('chat_session_update', ${payload})`);
  } catch (err) {
    logger.warn("chat_session_update notify failed", { sessionId, error: String(err) });
  }
}
