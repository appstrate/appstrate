// SPDX-License-Identifier: Apache-2.0

/**
 * Who may follow which realtime frames. One rule for every in-API consumer of
 * the fan-out in `services/realtime.ts`: the SSE routes (`routes/realtime.ts`)
 * and the MCP `run_and_wait` progress (`modules/mcp/tools.ts`) both ask the
 * functions below, so a caller receives over either transport exactly what it
 * may read over HTTP.
 */

import { and, eq } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { canReadRuns } from "@appstrate/core/permissions";
import { getErrorMessage } from "@appstrate/core/errors";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import type { RunLogEvent } from "@appstrate/shared-types";
import { addSubscriber, removeSubscriber, REALTIME_CHANNELS } from "./realtime.ts";
import type { RealtimeChannel } from "./realtime.ts";
import { canReadEveryRun, ownsRun } from "../lib/run-visibility.ts";
import type { Permission } from "../lib/permissions.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { logger } from "../lib/logger.ts";

/** The principal a realtime subscription answers to, in the space it streams. */
export interface RealtimeCaller {
  scope: SpaceScope;
  actor: Actor;
  /** Effective permissions in the streamed space (a key: ceiling ∩ creator). */
  permissions: ReadonlySet<string>;
  /** Does the caller's scope ceiling (a delegated credential's scopes) allow `permission`? */
  ceilingAllows: (permission: Permission) => boolean;
}

const readsRuns = (caller: RealtimeCaller) => canReadRuns((p) => caller.permissions.has(p));

/**
 * Who may receive each channel: who may read its rows over HTTP — a run read
 * (RBAC spec §3.4), the `chat:read` grant of `/api/chat/*`, the ceiling alone of
 * `GET /api/me/connections` (§7.1). Total, so no channel ships without a rule.
 */
const CHANNEL_REQUIREMENTS: Record<RealtimeChannel, (caller: RealtimeCaller) => boolean> = {
  run_update: readsRuns,
  run_log: readsRuns,
  run_metric: readsRuns,
  connection_update: (caller) => caller.ceilingAllows("integrations:read"),
  chat_session_update: (caller) => caller.permissions.has("chat:read"),
};

/** The requested channels — every channel when none is requested — this caller may receive. */
export function subscribedChannels(
  caller: RealtimeCaller,
  requested: ReadonlySet<RealtimeChannel> | undefined,
): ReadonlySet<RealtimeChannel> {
  return new Set(
    [...(requested ?? REALTIME_CHANNELS)].filter((channel) =>
      CHANNEL_REQUIREMENTS[channel](caller),
    ),
  );
}

/**
 * May this caller follow `runId`? A run it may not read answers `false`, so the
 * caller refuses it like the HTTP run routes do (404). A run id with no row
 * answers `true`: a stream opened the moment a launch fires may precede the
 * row, and the fan-out's run-read gate still filters every frame of it.
 */
export async function mayFollowRun(caller: RealtimeCaller, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: runs.userId, endUserId: runs.endUserId })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, caller.scope.orgId),
        eq(runs.spaceId, caller.scope.spaceId),
      ),
    )
    .limit(1);
  return !row || canReadEveryRun(caller.permissions) || ownsRun(caller.actor, row);
}

/**
 * Deliver the `run_log` frames of `runId` to `onLog` until the returned
 * function is called. Same gates as the SSE run stream — {@link subscribedChannels}
 * and {@link mayFollowRun} — with debug-level lines excluded. The subscriber
 * registers once the visibility check resolves; stopping before that registers
 * nothing. Every API instance LISTENs to the shared PostgreSQL, so the frames
 * arrive whichever instance the run's logs are written from.
 */
export function followRunLogs(
  caller: RealtimeCaller,
  runId: string,
  onLog: (log: RunLogEvent) => void,
  mayFollow: (caller: RealtimeCaller, runId: string) => Promise<boolean> = mayFollowRun,
): () => void {
  const subId = `run-log-${runId}-${crypto.randomUUID().slice(0, 8)}`;
  const channels = subscribedChannels(caller, new Set(["run_log"]));
  let stopped = false;
  if (channels.size > 0) {
    void mayFollow(caller, runId)
      .then((allowed) => {
        if (!allowed || stopped) return;
        addSubscriber({
          id: subId,
          filter: {
            runId,
            orgId: caller.scope.orgId,
            spaceId: caller.scope.spaceId,
            isAdmin: false,
            readAll: canReadEveryRun(caller.permissions),
            ...(caller.actor.type === "end_user"
              ? { endUserId: caller.actor.id }
              : { userId: caller.actor.id }),
            channels,
          },
          send: (evt) => {
            if (evt.event === "run_log") onLog(evt.data);
          },
        });
      })
      .catch((err: unknown) => {
        logger.warn("realtime: run log follow failed", { runId, error: getErrorMessage(err) });
      });
  }
  return () => {
    stopped = true;
    removeSubscriber(subId);
  };
}
