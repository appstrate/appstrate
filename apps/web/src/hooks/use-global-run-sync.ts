// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { withViewAsParam } from "../lib/scoping-headers";
import { endPreviewIfRefused } from "../lib/view-as-refusal";
import { useViewAsHeader } from "../stores/view-as-store";
import {
  runKeys,
  paginatedRunsKeys,
  packageKeys,
  agentsKeys,
  scheduleKeys,
} from "../lib/query-keys";
import {
  type EnrichedRun,
  type RunUpdateEvent,
  TERMINAL_RUN_STATUSES,
  runUpdateEventSchema,
  runUpdateToRunPatch,
} from "@appstrate/shared-types";

/**
 * Patch caches when an `integration_connections` row changes (INSERT /
 * UPDATE / DELETE) — drives the live "Reconnection required" badge on
 * the connections page, the agent picker verdict, the integration detail
 * connection list, and the agent status cards. `refetchOnWindowFocus` is
 * globally false (`main.tsx`), so these caches move on exactly two things:
 * a live frame here, and the reconnect reconciliation (`createGapReconciler`).
 *
 * Server-side actor filter in `services/realtime.ts:connection_update`
 * means we only see our own rows; a cross-actor change (e.g. someone else
 * sharing a connection) reaches this tab at the next reconnect or mutation,
 * which is acceptable because the run-time resolver gate enforces the
 * server-side truth anyway.
 */
function handleConnectionUpdate(qc: QueryClient) {
  // Connections page (`/preferences/connections`, whose orange "Reconnection
  // required" badge reads off `/api/me/connections`), integration list
  // (sidebar status, integrations page count) + detail subtree (auth
  // statuses, connection lists, agent-resolution verdicts, the resolution
  // verdict that powers the agent picker dropdown) — all refreshed by the
  // shared helper, which matches on the typed key's path element.
  void invalidateIntegrationQueries(qc);
}

/**
 * Which cached queries a `chat_session_update` for `sessionId` must refetch.
 * Pure — exported for its test.
 *
 * Three families, matched on their React Query keys:
 *  - the module's session list (`["chat","sessions"]`) — ALWAYS: it is the
 *    signal-only protocol's single source of the session DTO.
 *  - the typed session detail, `["get","/api/chat/sessions/{id}",init]` with
 *    `init.params.path.id` (openapi-react-query key shape) — only the one
 *    whose path id is this session.
 *  - the typed file list, `["get","/api/files",init]` with
 *    `init.params.query.context_chat_session_id` — only the page filtered on
 *    this session. A run's file tab (`runId` filter), the gallery (no
 *    filter) or another conversation's sidebar must not refetch on every
 *    frame of a turn that is not theirs (≥5 frames per turn).
 *
 * `sessionId` undefined (frame did not parse, or the reconnect reconciliation
 * where the missed frames' ids are unknowable) → every member of the three
 * families: a missed signal must degrade to "too many refetches", never to a
 * stale sidebar.
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

/**
 * Refetch the chat conversation list when the chat module signals a session
 * change (message persisted, read marker advanced on another device, rename,
 * delete, `generating` flip). Signal-only frame → invalidate, the list GET is
 * the single source of the session DTO. Deliberately NOT routed through the
 * throttled broad invalidator: chat emits a handful of frames per turn (not a
 * per-log firehose like runs) and the unread badge / spinner should react
 * instantly. The key is the module's `SESSIONS_QUERY_KEY` (re-exported from
 * `@appstrate/module-chat/unread`, already imported by the nav badge);
 * importing the constant is harmless when the chat feature is disabled — no
 * chat query is mounted, the invalidation matches nothing.
 *
 * The context sidebar's typed session detail and file list are scoped to the
 * frame's session (`matchesChatSessionQuery`): the wire frame is the
 * `chat_session_update` NOTIFY payload after the fan-out's camelCase +
 * schema pass (`{ sessionId, orgId, userId }`, `services/realtime.ts`).
 * `raw` undefined = reconnect reconciliation → unscoped.
 */
function handleChatSessionUpdate(qc: QueryClient, raw?: string) {
  const sessionId = raw === undefined ? undefined : parseChatSessionId(raw);
  void qc.invalidateQueries({ predicate: (q) => matchesChatSessionQuery(q.queryKey, sessionId) });
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

/**
 * Throttle (~2s) for the BROAD invalidations a `run_update` triggers: the run
 * caches are patched in place (cheap), a refetch fan-out per SSE message is
 * not. The trigger's `WHEN` clause (`packages/db/src/notify.ts`) only fires on
 * a status/timestamp transition, so this collapses bursts, not a firehose.
 */
interface BroadInvalidator {
  schedule: (key: readonly unknown[]) => void;
  dispose: () => void;
}

/**
 * Exported for its test. The budget this buys: under sustained traffic at most
 * 4 broad invalidations per `delayMs` per open tab — one per `broadRunKeys`
 * entry — against zero under the debounce it replaced, which never flushed.
 */
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
 * Single writer of the run-detail cache from a `run_update` frame; returns the
 * patch it applied, or `null` when the frame is dropped:
 * a per-connection snapshot can predate a live frame, and status only moves on.
 */
export function patchRunDetail(
  qc: QueryClient,
  orgId: string,
  spaceId: string,
  evt: RunUpdateEvent,
): Partial<EnrichedRun> | null {
  const key = runKeys.detail(orgId, spaceId, evt.id);
  const cached = qc.getQueryData<EnrichedRun>(key);
  if (
    cached &&
    TERMINAL_RUN_STATUSES.has(cached.status) &&
    !TERMINAL_RUN_STATUSES.has(evt.status)
  ) {
    return null;
  }
  const patch = runUpdateToRunPatch(evt);
  qc.setQueryData<EnrichedRun>(key, (prev) => (prev ? { ...prev, ...patch } : prev));
  return patch;
}

/**
 * The list/agent caches a `run_update` moves but cannot patch in place. ONE
 * list, fed to the per-event throttle AND to the reconnect reconciliation, so
 * the latter cannot drift into a silent subset of the former. Exported for its
 * test.
 */
export function broadRunKeys(orgId: string): readonly (readonly unknown[])[] {
  return [
    paginatedRunsKeys.all,
    agentsKeys.inOrg(orgId),
    // Agent detail caches are keyed ["packages","agents",orgId,spaceId,id], so
    // the org-scoped prefix is what refreshes an agent's config/model tabs.
    packageKeys.familyInOrg("agents", orgId),
    // The chat context sidebar reads this typed collection, not paginated-runs.
    ["get", "/api/runs"],
  ];
}

/**
 * Refetch the run families after a stream gap. Run LOGS are deliberately absent:
 * the run-detail page appends live frames into that cache and a refetch would
 * drop the per-turn breadcrumbs it holds (see `invalidateRunLogs`).
 */
function reconcileRunQueries(qc: QueryClient, orgId: string) {
  // Run detail/list caches are patched in place by live frames, so only a gap
  // needs them refetched — they are not part of the per-event throttle.
  for (const queryKey of [runKeys.all, ...broadRunKeys(orgId)]) {
    qc.invalidateQueries({ queryKey });
  }
}

/**
 * What a (re)connect owes the caches. The protocol is signal-only: a frame
 * emitted while the stream was down is lost for good, so every family a frame
 * would have moved is refetched once the stream is back. That is what lets the
 * notification and chat polls be slow backstops instead of the freshness
 * mechanism.
 *
 * Only a RE-connect has such a gap. The first connect opens beside the mount's
 * own queries, and reconciling there issued each of them a second time on every
 * page load.
 *
 * The run families are rate-limited on top: the server writes a frame on every
 * connection, so a repeatedly dropped stream would reconcile at ~1 Hz and storm
 * itself. Exported for its test.
 */
export function createGapReconciler(
  getQueryClient: () => QueryClient,
  orgId: string,
  runReconcileMinIntervalMs = 10_000,
): (now: number) => void {
  let connectedOnce = false;
  let lastRunReconcileAt = 0;
  return (now) => {
    if (!connectedOnce) {
      connectedOnce = true;
      return;
    }
    const qc = getQueryClient();
    handleChatSessionUpdate(qc);
    invalidateNotificationQueries(qc);
    if (now - lastRunReconcileAt >= runReconcileMinIntervalMs) {
      lastRunReconcileAt = now;
      reconcileRunQueries(qc, orgId);
      // `connection_update` frames were missed on the same stream.
      handleConnectionUpdate(qc);
    }
  };
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

  // Broad invalidations are throttled (~2s) — the in-place cache patch above
  // keeps the visible run live in the meantime.
  for (const key of broadRunKeys(orgId)) broad.schedule(key);

  // Invalidate schedule-specific caches
  if (scheduleId) {
    qc.invalidateQueries({ queryKey: scheduleKeys.runs(orgId, spaceId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.detail(orgId, spaceId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.list(orgId, spaceId) });
  }

  if (TERMINAL_RUN_STATUSES.has(status)) {
    invalidateNotificationQueries(qc);
    qc.invalidateQueries({ queryKey: runKeys.all });
    // A terminal run has completed its output sweep; refresh every scoped
    // file collection, including conversation-context filters.
    qc.invalidateQueries({ queryKey: ["get", "/api/files"] });
    // openapi-react-query keys are [method, path, init] — invalidating the
    // literal spec path reaches the entry whatever org rides in its init.
    qc.invalidateQueries({ queryKey: ["get", "/api/billing"] });
  }
}

/**
 * The channels the hook dispatches on that the caller can receive — never the
 * `run_log` firehose. An effect dep: a new set reopens the stream under the new
 * grants. Exported for its test.
 */
export function globalStreamChannels(caller: { readsRuns: boolean; readsChat: boolean }): string {
  return [
    ...(caller.readsRuns ? ["run_update"] : []),
    "connection_update",
    ...(caller.readsChat ? ["chat_session_update"] : []),
  ].join(",");
}

/**
 * A 4xx other than 429 answers the request itself (session, grants, space,
 * persona): the effect reopens when one changes, not on a timer. Exported for its test.
 */
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
 * Global SSE subscription on run changes.
 * Uses fetch + ReadableStream instead of EventSource to avoid
 * Safari's aggressive auto-reconnect behavior on connection failure.
 */
export function useGlobalRunSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  // Same reason as the org/space ids beside it: this stream is opened once and
  // would otherwise keep filling the cache with the other authority's rows.
  const viewAs = useViewAsHeader();
  const { can, ready } = usePermissions();
  const canReach = useCanReach();
  // Null until the grants load, or the stream would open without `run_update`
  // and reopen a moment later.
  const channels = ready
    ? globalStreamChannels({ readsRuns: canReadRuns(can), readsChat: canReach("/chat") })
    : null;
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!orgId || !spaceId || !channels) return;

    const controller = new AbortController();
    const broad = createBroadInvalidator(() => qcRef.current);

    // Bounded exponential backoff. A non-OK response (e.g. the endpoint is
    // briefly unavailable during a redeploy) or a stream that simply ends
    // used to leave the cache stale forever; we now reconnect so live run
    // updates resume once the endpoint is back. Still fetch + ReadableStream
    // (NOT EventSource) so Safari can't run its own uncontrolled reconnect.
    const BASE_DELAY_MS = 1000;
    const MAX_DELAY_MS = 30_000;
    let attempt = 0;
    const reconcileGap = createGapReconciler(() => qcRef.current, orgId);

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          // Timer fired normally — drop the abort listener so it doesn't leak
          // for the lifetime of the controller (one per reconnect delay).
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

    // One connection attempt: "refused" for an answer the server would give
    // again, "ended" when the stream closes; throws on a transient failure.
    const connectOnce = async () => {
      const res = await fetch(
        // `verbose` is deliberately absent: it only affects `run_log`, which
        // we no longer subscribe to.
        withViewAsParam(
          `/api/realtime/runs?orgId=${encodeURIComponent(orgId)}&spaceId=${encodeURIComponent(spaceId)}&channels=${channels}`,
          viewAs,
        ),
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

      reconcileGap(Date.now());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // A 200 followed by an immediate close would otherwise reset the backoff
      // on `res.ok` and re-hammer the endpoint at 1 req/s forever. Only reset
      // the backoff once the stream actually delivers a frame — a healthy
      // connection — so the next real drop starts from BASE again.
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
      // Jitter — de-synchronize reconnect stampedes (every tab reconnects
      // at once after a redeploy).
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
