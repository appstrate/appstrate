// SPDX-License-Identifier: Apache-2.0

import { realtimeRunsUrl } from "@appstrate/core/realtime-url";
import { useEffect, useRef } from "react";
import { useQueryClient, type InvalidateOptions, type QueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { usePermissions } from "./use-permissions";
import { useCanReach } from "./use-can-reach";
import { invalidateIntegrationQueries } from "./use-integrations";
import { invalidateNotificationQueries } from "./use-notifications";
import { parseSseFrames } from "@appstrate/core/sse";
import { canReadRuns } from "@appstrate/core/permissions";
import { SESSIONS_QUERY_KEY as CHAT_SESSIONS_QUERY_KEY } from "@appstrate/module-chat/unread";
import { chatSessionUpdateEventSchema } from "@appstrate/shared-types";
import { endPreviewIfRefused } from "../lib/view-as-refusal";
import { useViewAsHeader } from "../stores/view-as-store";
import {
  runKeys,
  paginatedRunsKeys,
  packageKeys,
  agentsKeys,
  scheduleKeys,
  persistenceKeys,
  invalidatePaths,
} from "../lib/query-keys";
import {
  type EnrichedRun,
  type RunUpdateEvent,
  TERMINAL_RUN_STATUSES,
  runUpdateEventSchema,
  runUpdateToRunPatch,
} from "@appstrate/shared-types";

/**
 * Refresh every cache an `integration_connections` change moves. `refetchOnWindowFocus` is off,
 * so these move only on a live frame or the reconnect reconciliation; the server filters by actor.
 */
function handleConnectionUpdate(qc: QueryClient) {
  void invalidateIntegrationQueries(qc);
}

/**
 * Which queries a `chat_session_update` for `sessionId` must refetch: the session list always;
 * the session detail and file list only when keyed on this session. `sessionId` undefined
 * (unparsable frame, reconnect) → all: a missed signal must never leave a stale sidebar.
 */
export function matchesChatSessionQuery(
  queryKey: readonly unknown[],
  sessionId: string | undefined,
): boolean {
  const [method, path, init] = queryKey;
  if (method === CHAT_SESSIONS_QUERY_KEY[0] && path === CHAT_SESSIONS_QUERY_KEY[1]) return true;
  if (method !== "get") return false;
  if (path === "/api/chat/sessions/{id}") {
    return sessionId === undefined || readPathId(init) === sessionId;
  }
  if (path === "/api/files") {
    return sessionId === undefined || readContextChatSessionId(init) === sessionId;
  }
  return false;
}

function readPathId(init: unknown): unknown {
  const params = (init as { params?: { path?: { id?: unknown } } } | undefined)?.params;
  return params?.path?.id;
}

function readContextChatSessionId(init: unknown): unknown {
  const params = (
    init as { params?: { query?: { context_chat_session_id?: unknown } } } | undefined
  )?.params;
  return params?.query?.context_chat_session_id;
}

/** Deliberately NOT throttled: the unread badge / spinner should react instantly. `raw` undefined = reconnect → unscoped. */
function handleChatSessionUpdate(qc: QueryClient, raw?: string, options?: InvalidateOptions) {
  const sessionId = raw === undefined ? undefined : parseChatSessionId(raw);
  void qc.invalidateQueries(
    { predicate: (q) => matchesChatSessionQuery(q.queryKey, sessionId) },
    options,
  );
}

function parseChatSessionId(raw: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined; // malformed frame → unscoped
  }
  const parsed = chatSessionUpdateEventSchema.safeParse(json);
  return parsed.success ? parsed.data.sessionId : undefined;
}

/** Throttle (~2s) for the BROAD invalidations a `run_update` triggers: run caches are patched in place, a refetch fan-out per SSE message is not. */
interface BroadInvalidator {
  schedule: (key: readonly unknown[]) => void;
  dispose: () => void;
}

/** Exported for its test. At most one invalidation per `broadRunKeys` entry per `delayMs` per tab. */
export function createBroadInvalidator(
  getQueryClient: () => QueryClient,
  delayMs = 2000,
): BroadInvalidator {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, readonly unknown[]>();

  const flush = () => {
    timer = null;
    const qc = getQueryClient();
    for (const key of pending.values()) {
      qc.invalidateQueries({ queryKey: key as unknown[] });
    }
    pending.clear();
  };

  return {
    schedule(key) {
      pending.set(JSON.stringify(key), key);
      // Throttle, not debounce: arm on the first event, let the burst accumulate.
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

/**
 * Single writer of the run-detail cache from a `run_update` frame; `false` when the frame is
 * dropped as stale (a snapshot can predate a live frame, and status only moves on).
 */
export function patchRunDetail(
  qc: QueryClient,
  orgId: string,
  spaceId: string,
  evt: RunUpdateEvent,
): boolean {
  const key = runKeys.detail(orgId, spaceId, evt.id);
  const cached = qc.getQueryData<EnrichedRun>(key);
  if (
    cached &&
    TERMINAL_RUN_STATUSES.has(cached.status) &&
    !TERMINAL_RUN_STATUSES.has(evt.status)
  ) {
    return false;
  }
  const patch = runUpdateToRunPatch(evt);
  qc.setQueryData<EnrichedRun>(key, (prev) => (prev ? { ...prev, ...patch } : prev));
  return true;
}

/**
 * The list/agent caches a `run_update` moves but cannot patch in place. ONE list, fed to the
 * per-event throttle AND the reconnect reconciliation so they cannot drift. Exported for its test.
 */
export function broadRunKeys(orgId: string): readonly (readonly unknown[])[] {
  return [
    paginatedRunsKeys.all,
    agentsKeys.inOrg(orgId),
    // Agent detail keys are ["packages","agents",orgId,spaceId,id]: the org prefix refreshes them.
    packageKeys.familyInOrg("agents", orgId),
    // The chat context sidebar reads this typed collection, not paginated-runs.
    ["get", "/api/runs"],
  ];
}

/** Refetch the run families after a gap. Run LOGS are absent on purpose: a refetch drops the breadcrumbs run-detail appends. */
function reconcileRunQueries(qc: QueryClient, orgId: string) {
  for (const queryKey of [runKeys.all, ...broadRunKeys(orgId)]) {
    qc.invalidateQueries({ queryKey }, KEEP_IN_FLIGHT);
  }
}

/**
 * A connection after a gap refetches what the lost frames would have moved; only a scope's first
 * attempt owes nothing. Coverage lives in the query cache, so a wipe forgets it. A frame between
 * a read and the subscription is left to the polls.
 */
export function trackStreamGaps(
  getQueryClient: () => QueryClient,
  orgId: string,
  scope: string,
): StreamGaps {
  getQueryClient().setQueryDefaults(STREAM_COVERAGE, { gcTime: Infinity });
  const coverageKey = [...STREAM_COVERAGE, scope];
  let gap = getQueryClient().getQueryData(coverageKey) !== undefined;
  let lastRunReconcileAt = 0;
  return {
    missed() {
      gap = true;
    },
    connected(now) {
      const qc = getQueryClient();
      qc.setQueryData(coverageKey, true);
      if (!gap) {
        gap = true;
        return;
      }
      handleChatSessionUpdate(qc, undefined, KEEP_IN_FLIGHT);
      invalidateNotificationQueries(qc, KEEP_IN_FLIGHT);
      // A stream dropped in a loop would otherwise sweep the run caches at ~1 Hz.
      if (now - lastRunReconcileAt >= RUN_RECONCILE_MIN_INTERVAL_MS) {
        lastRunReconcileAt = now;
        reconcileRunQueries(qc, orgId);
        handleConnectionUpdate(qc);
      }
    },
  };
}

// A read in flight at connect time left after the gap: restarting it issues it twice.
const KEEP_IN_FLIGHT: InvalidateOptions = { cancelRefetch: false };
const RUN_RECONCILE_MIN_INTERVAL_MS = 10_000;
const STREAM_COVERAGE = ["realtime-covered"] as const;

interface StreamGaps {
  missed: () => void;
  connected: (now: number) => void;
}

function handleSSEMessage(
  qc: QueryClient,
  broad: BroadInvalidator,
  orgId: string,
  spaceId: string,
  raw: string,
) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return; // malformed frame
  }
  const parsed = runUpdateEventSchema.safeParse(json);
  if (!parsed.success) return;
  const evt = parsed.data;
  const { status, scheduleId } = evt;
  // Frame dropped as stale — nothing below may move on it either.
  if (!patchRunDetail(qc, orgId, spaceId, evt)) return;

  for (const key of broadRunKeys(orgId)) broad.schedule(key);

  if (scheduleId) {
    qc.invalidateQueries({ queryKey: scheduleKeys.runs(orgId, spaceId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.detail(orgId, spaceId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.list(orgId, spaceId) });
  }

  if (TERMINAL_RUN_STATUSES.has(status)) {
    invalidateNotificationQueries(qc);
    qc.invalidateQueries({ queryKey: runKeys.all });
    // A terminal run has finished writing its output files and memory (pinned slots, notes).
    void invalidatePaths(qc, ["/api/files"]);
    qc.invalidateQueries({ queryKey: persistenceKeys.all });
    void invalidatePaths(qc, ["/api/billing"]);
  }
}

/** The channels the caller can receive, never the `run_log` firehose. An effect dep: a new set reopens the stream. Exported for its test. */
export function globalStreamChannels(caller: { readsRuns: boolean; readsChat: boolean }): string {
  return [
    ...(caller.readsRuns ? ["run_update"] : []),
    "connection_update",
    ...(caller.readsChat ? ["chat_session_update"] : []),
  ].join(",");
}

/** A 4xx other than 429 answers the request itself: the effect reopens when its inputs change, not on a timer. Exported for its test. */
export function isRetryableStreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Reconnect until aborted or refused; a throw is retried like an ended stream. Exported for its test. */
export async function reconnectUntilRefused(
  connect: () => Promise<"refused" | "ended">,
  signal: AbortSignal,
  backoff: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    const outcome = await connect().catch(() => "failed" as const);
    if (signal.aborted || outcome === "refused") return;
    await backoff();
  }
}

/**
 * Global SSE subscription on run changes. Uses fetch + ReadableStream, NOT EventSource, to avoid
 * Safari's uncontrolled auto-reconnect — do not convert.
 */
export function useGlobalRunSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  // Like the org/space ids: else the stream keeps filling the cache with the other authority's rows.
  const viewAs = useViewAsHeader();
  const { can, ready } = usePermissions();
  const canReach = useCanReach();
  // Null until the grants load, or the stream opens without `run_update` and reopens.
  const channels = ready
    ? globalStreamChannels({ readsRuns: canReadRuns(can), readsChat: canReach("/chat") })
    : null;
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!orgId || !spaceId || !channels) return;

    const controller = new AbortController();
    const broad = createBroadInvalidator(() => qcRef.current);

    // Bounded exponential backoff.
    const BASE_DELAY_MS = 1000;
    const MAX_DELAY_MS = 30_000;
    let attempt = 0;
    const reconciler = trackStreamGaps(
      () => qcRef.current,
      orgId,
      JSON.stringify([orgId, spaceId, viewAs]),
    );

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          // Drop the abort listener so it doesn't leak for the controller's lifetime.
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

    // One attempt: "refused" for an answer the server would repeat, "ended" on close; throws if transient.
    const connectOnce = async () => {
      const res = await fetch(
        // `verbose` is absent: it only affects `run_log`, which we do not subscribe to.
        realtimeRunsUrl({ orgId, spaceId, channels: channels.split(","), viewAs }),
        {
          credentials: "include",
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) {
        // A refused persona also ends the preview the banner still claims.
        await endPreviewIfRefused(res);
        if (!res.ok && !isRetryableStreamStatus(res.status)) return "refused" as const;
        throw new Error(`realtime stream unavailable (${res.status})`);
      }

      reconciler.connected(Date.now());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Reset the backoff only once a frame arrives: a 200 followed by an immediate close
      // would otherwise re-hammer the endpoint at 1 req/s forever.
      let firstFrameSeen = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const { frames, buffer } = parseSseFrames(decoder.decode(value, { stream: true }), buf);
        buf = buffer;

        if (!firstFrameSeen && frames.length > 0) {
          firstFrameSeen = true;
          attempt = 0;
        }

        for (const { event, data } of frames) {
          if (event === "run_update" && data) {
            handleSSEMessage(qcRef.current, broad, orgId, spaceId, data);
          } else if (event === "connection_update" && data) {
            handleConnectionUpdate(qcRef.current);
          } else if (event === "chat_session_update" && data) {
            handleChatSessionUpdate(qcRef.current, data);
          }
        }
      }
      return "ended" as const;
    };

    void reconnectUntilRefused(connectOnce, controller.signal, () => {
      reconciler.missed();
      // Jitter de-synchronizes reconnect stampedes after a redeploy.
      const delay =
        Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) * (0.5 + Math.random() * 0.5);
      attempt++;
      return sleep(delay);
    });

    return () => {
      controller.abort();
      broad.dispose();
    };
  }, [orgId, spaceId, viewAs, channels]);
}
