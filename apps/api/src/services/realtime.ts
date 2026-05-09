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

  logger.info("Realtime LISTEN channels initialized");
}

export function addSubscriber(sub: Subscriber): void {
  subscribers.set(sub.id, sub);
}

export function removeSubscriber(id: string): void {
  subscribers.delete(id);
}
