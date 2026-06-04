// SPDX-License-Identifier: Apache-2.0

import { listenClient } from "@appstrate/db/client";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export type RealtimeEvent = {
  event: string;
  data: Record<string, unknown>;
};

type Subscriber = {
  id: string;
  filter: {
    runId?: string;
    packageId?: string;
    orgId: string;
    applicationId: string;
    isAdmin?: boolean;
    /**
     * Actor identity for the `connection_update` channel. The trigger
     * fires for every connection on the application; the subscriber
     * forwards a row when it belongs to this actor (own connection).
     * Cross-actor shared-connection invalidations rely on the consumer
     * refetching from the server, so we don't need the shared/owner
     * tables here. Either `userId` or `endUserId` is set, never both.
     */
    userId?: string;
    endUserId?: string;
  };
  send: (event: RealtimeEvent) => void;
};

const subscribers = new Map<string, Subscriber>();
let initialized = false;

/** Convert snake_case keys from PG NOTIFY to camelCase for API consistency. */
function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

/**
 * Initialize PG LISTEN channels for run_update and run_log_insert.
 * Safe to call multiple times — only initializes once.
 */
export async function initRealtime(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await listenClient.listen("run_update", (payload) => {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>;
      const data = snakeToCamel(raw);
      for (const sub of subscribers.values()) {
        if (sub.filter.orgId !== raw.org_id) continue;
        if (sub.filter.applicationId !== raw.application_id) continue;
        if (sub.filter.runId && sub.filter.runId !== raw.id) continue;
        if (sub.filter.packageId && sub.filter.packageId !== raw.package_id) continue;
        sub.send({ event: "run_update", data });
      }
    } catch (err) {
      logger.error("Failed to parse run_update payload", {
        error: getErrorMessage(err),
      });
    }
  });

  await listenClient.listen("run_log_insert", (payload) => {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>;
      const data = snakeToCamel(raw);
      for (const sub of subscribers.values()) {
        if (sub.filter.orgId !== raw.org_id) continue;
        if (sub.filter.applicationId !== raw.application_id) continue;
        if (sub.filter.runId && sub.filter.runId !== raw.run_id) continue;
        if (!sub.filter.isAdmin && raw.level === "debug") continue;
        sub.send({ event: "run_log", data });
      }
    } catch (err) {
      logger.error("Failed to parse run_log_insert payload", {
        error: getErrorMessage(err),
      });
    }
  });

  // `run_metric` carries the running cumulative cost + token usage
  // emitted by the event sink after each `appstrate.metric` event,
  // throttled per run by the broadcaster. Routed to the same
  // org/application/run filters as `run_update` and `run_log_insert`
  // — no new isolation rule. The scope filters here are the ONLY
  // tenant gate for this channel; do not relax without updating the
  // broadcaster payload contract.
  await listenClient.listen("run_metric", (payload) => {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>;
      const data = snakeToCamel(raw);
      for (const sub of subscribers.values()) {
        if (sub.filter.orgId !== raw.org_id) continue;
        if (sub.filter.applicationId !== raw.application_id) continue;
        if (sub.filter.runId && sub.filter.runId !== raw.run_id) continue;
        if (sub.filter.packageId && sub.filter.packageId !== raw.package_id) continue;
        sub.send({ event: "run_metric", data });
      }
    } catch (err) {
      logger.error("Failed to parse run_metric payload", {
        error: getErrorMessage(err),
      });
    }
  });

  // `connection_update` carries every INSERT/UPDATE/DELETE on
  // `integration_connections` so the dashboard can patch its caches in
  // real time — the orange "Reconnection required" badge, the agent
  // page's member picker verdict, the integration detail's connection
  // row all read off React Query keys that this event invalidates.
  //
  // Filter is per-application; the subscriber owns its actor identity
  // (set at SSE auth time) so a member only sees their own rows. The
  // payload deliberately omits `org_id` (the table has none) — tenant
  // isolation is bound to the upstream SSE auth gate proving
  // `applicationId ∈ orgId`.
  await listenClient.listen("connection_update", (payload) => {
    try {
      const raw = JSON.parse(payload) as Record<string, unknown>;
      const data = snakeToCamel(raw);
      for (const sub of subscribers.values()) {
        if (sub.filter.applicationId !== raw.application_id) continue;
        // Actor filter: only fan out rows the subscriber owns. Without
        // this, every member of an app would receive every other
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
  });

  logger.info("Realtime LISTEN channels initialized");
}

export function addSubscriber(sub: Subscriber): void {
  subscribers.set(sub.id, sub);
}

export function removeSubscriber(id: string): void {
  subscribers.delete(id);
}
