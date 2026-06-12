// SPDX-License-Identifier: Apache-2.0

/**
 * Long-poll support for `GET /api/runs/:id?wait=…` (issue #631).
 *
 * MCP clients cannot consume the SSE stream, so without this they must
 * loop `sleep` + `getRun`, burning one round-trip (and context tokens for
 * the full run payload) per poll. `?wait=<seconds>` instead holds the
 * request server-side until the run reaches a terminal status or the wait
 * elapses, then returns the run object as usual — each iteration is one
 * cheap long poll instead of N short polls.
 *
 * Wakeup mechanism (in priority order):
 *
 *  1. **PG NOTIFY** — the `runs_notify_trigger` fires `run_update` on every
 *     `runs` UPDATE; `services/realtime.ts` LISTENs once per process and
 *     fans out to in-process subscribers. This works across multi-instance
 *     deployments (each instance holds its own LISTEN connection to the
 *     shared PostgreSQL) AND in Tier-0 (PGlite implements LISTEN/NOTIFY
 *     in-process). No Redis involved.
 *  2. **Fallback DB poll** — a 2 s interval re-reads `runs.status` with a
 *     single narrow indexed query. Covers the case where the realtime
 *     listener is not initialized or a NOTIFY is lost; each poll borrows a
 *     pooled connection for one query — the wait never pins a connection.
 *
 * The wait is capped at {@link MAX_WAIT_SECONDS} (55 s), deliberately below
 * the 60 s idle/read timeouts that ship as defaults in common reverse
 * proxies (nginx `proxy_read_timeout`, AWS ALB idle timeout, Cloudflare's
 * 100 s, …) so the long poll always completes with a real response instead
 * of a proxy-generated 504. A response carrying a non-terminal status just
 * means "poll again".
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, TERMINAL_RUN_STATUSES, type RunStatus } from "@appstrate/db/schema";
import { addSubscriber, removeSubscriber } from "./realtime.ts";
import { invalidRequest } from "../lib/errors.ts";
import type { AppScope } from "../lib/scope.ts";

/**
 * Server-side wait ceiling, in seconds. Kept below typical proxy idle
 * timeouts (commonly 60 s) — see module doc. Values above the cap are
 * clamped rather than rejected so clients can pass a generous number and
 * let the server decide (same convention as long-poll `timeout` params in
 * e.g. the Kubernetes watch API).
 */
export const MAX_WAIT_SECONDS = 55;

/** Fallback DB re-check cadence while waiting (see module doc, point 2). */
const FALLBACK_POLL_INTERVAL_MS = 2_000;

/**
 * Per-identity concurrent-waiter ceiling. Each waiter holds an HTTP
 * connection for up to {@link MAX_WAIT_SECONDS} and registers a realtime
 * subscriber, so an unbounded caller could pin one connection per request.
 * Beyond the cap the wait **degrades to no-wait**: the route returns the
 * current run resource immediately (non-breaking — a non-terminal status
 * already means "poll again"), and capacity self-heals as earlier waits
 * resolve. Documented on the OpenAPI `wait` parameter.
 */
export const MAX_CONCURRENT_WAITERS_PER_IDENTITY = 10;

/** Live waiter count per identity (userId / `apikey:<id>`). */
const waiterCounts = new Map<string, number>();

/** Test-only introspection — current number of live waits for an identity. */
export function activeWaiterCount(identity: string): number {
  return waiterCounts.get(identity) ?? 0;
}

function releaseWaiterSlot(identity: string): void {
  const current = waiterCounts.get(identity) ?? 0;
  if (current <= 1) waiterCounts.delete(identity);
  else waiterCounts.set(identity, current - 1);
}

/**
 * Shared fallback-poll registry — ONE 2 s DB poll loop per runId, no matter
 * how many concurrent waiters hold a long poll on that run. Each entry fans
 * a terminal observation out to every registered waiter; the loop is torn
 * down when the last waiter detaches. (Pre-fix, every waiter ran its own
 * interval — N waiters on one run cost N identical indexed reads per tick.)
 */
interface RunPollEntry {
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
  waiters: Set<() => void>;
}

const runPolls = new Map<string, RunPollEntry>();

/** Test-only introspection — number of live shared poll loops. */
export function activePollLoopCount(): number {
  return runPolls.size;
}

/**
 * Attach `onTerminal` to the run's shared poll loop, creating the loop on
 * first attach. Returns a detach function (idempotent); detaching the last
 * waiter clears the interval and drops the registry entry. The first
 * attacher's `scope` and `pollIntervalMs` drive the loop — run ids are
 * globally unique so all waiters on a run share the same scope.
 */
function addSharedPollWaiter(
  runId: string,
  scope: AppScope,
  pollIntervalMs: number,
  onTerminal: () => void,
): () => void {
  let entry = runPolls.get(runId);
  if (!entry) {
    const created: RunPollEntry = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      inFlight: false,
      waiters: new Set(),
    };
    // Guarded so a slow query never stacks concurrent reads.
    created.timer = setInterval(() => {
      if (created.inFlight) return;
      created.inFlight = true;
      void isRunTerminal(scope, runId)
        .then((terminal) => {
          // Snapshot — each callback detaches itself from the set.
          if (terminal) for (const wake of [...created.waiters]) wake();
        })
        .catch(() => {
          // Transient read failure — the next tick (or each waiter's own
          // timeout) covers it.
        })
        .finally(() => {
          created.inFlight = false;
        });
    }, pollIntervalMs);
    runPolls.set(runId, created);
    entry = created;
  }
  entry.waiters.add(onTerminal);
  return () => {
    entry.waiters.delete(onTerminal);
    if (entry.waiters.size === 0 && runPolls.get(runId) === entry) {
      clearInterval(entry.timer);
      runPolls.delete(runId);
    }
  };
}

/**
 * `?wait=` accepts `true`/`false` (boolean form) or a non-negative integer
 * number of seconds. Negative, fractional, or non-numeric values are
 * rejected; values above {@link MAX_WAIT_SECONDS} are clamped to it.
 */
const waitQuerySchema = z.union([
  z.literal("true").transform(() => MAX_WAIT_SECONDS),
  z.literal("false").transform(() => 0),
  z.coerce
    .number()
    .int()
    .min(0)
    .transform((n) => Math.min(n, MAX_WAIT_SECONDS)),
]);

/**
 * Parse the raw `wait` query value into a wait budget in milliseconds.
 *
 * - `undefined` (param absent) → `0` (no wait — today's behavior)
 * - `""` (bare `?wait`) and `"true"` → the {@link MAX_WAIT_SECONDS} cap
 * - `"false"` / `"0"` → `0`
 * - integer seconds → clamped to the cap
 * - anything else → 400 `invalid_request`
 */
export function parseWaitQuery(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = waitQuerySchema.safeParse(raw === "" ? "true" : raw);
  if (!parsed.success) {
    throw invalidRequest(
      `Invalid 'wait' value: expected true, false, or a non-negative integer number of seconds (max ${MAX_WAIT_SECONDS})`,
      "wait",
    );
  }
  return parsed.data * 1000;
}

/** One narrow indexed read: is the run terminal right now? */
async function isRunTerminal(scope: AppScope, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, scope.orgId),
        eq(runs.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  // A run deleted mid-wait resolves the wait too — the caller re-reads and
  // surfaces its own 404 rather than holding the request for nothing.
  return row === undefined || TERMINAL_RUN_STATUSES.has(row.status);
}

/**
 * Hold until the run reaches a terminal status, the timeout elapses, or the
 * caller aborts — whichever comes first. Resolves `void` in every case; the
 * caller re-reads the run row afterwards and returns whatever state it
 * finds (non-terminal = the client should poll again).
 *
 * Cleanup contract: every exit path (event, poll hit, timeout, abort)
 * removes the realtime subscriber and clears both timers — nothing leaks
 * past resolution, including on client disconnect (`signal`).
 */
export async function waitForRunTerminal(opts: {
  runId: string;
  scope: AppScope;
  /** Wait budget in milliseconds (already capped by {@link parseWaitQuery}). */
  timeoutMs: number;
  /**
   * Auth identity holding this wait (userId / `apikey:<id>` — same keying
   * as the rate-limit middleware). When provided, the per-identity
   * concurrent-waiter cap applies: beyond
   * {@link MAX_CONCURRENT_WAITERS_PER_IDENTITY} live waits the call
   * degrades to no-wait (resolves immediately).
   */
  identity?: string;
  /** Request abort signal — stops the wait when the client disconnects. */
  signal?: AbortSignal;
  /** Fallback DB poll cadence override (tests). */
  pollIntervalMs?: number;
}): Promise<void> {
  const { runId, scope, timeoutMs, signal, identity } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;

  if (signal?.aborted || timeoutMs <= 0) return;

  // Per-identity concurrent-waiter cap — degrade to no-wait when exceeded.
  // The caller re-reads the run and answers immediately, exactly like a
  // `wait=0` request; the client's normal "non-terminal → poll again" loop
  // self-heals once earlier waits resolve.
  if (identity !== undefined) {
    const current = waiterCounts.get(identity) ?? 0;
    if (current >= MAX_CONCURRENT_WAITERS_PER_IDENTITY) return;
    waiterCounts.set(identity, current + 1);
  }

  await new Promise<void>((resolve) => {
    const subId = `wait-${runId}-${crypto.randomUUID().slice(0, 8)}`;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      detachPollWaiter();
      signal?.removeEventListener("abort", finish);
      removeSubscriber(subId);
      if (identity !== undefined) releaseWaiterSlot(identity);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    // Fallback poll — one shared DB loop per runId (see addSharedPollWaiter).
    const detachPollWaiter = addSharedPollWaiter(runId, scope, pollIntervalMs, finish);

    signal?.addEventListener("abort", finish, { once: true });

    // Primary wakeup: the realtime fan-out of the `run_update` PG NOTIFY.
    // The filter reuses the same org/application isolation gates as the SSE
    // subscribers; `isAdmin` only affects the run_log channel (unused here).
    addSubscriber({
      id: subId,
      filter: {
        runId,
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        isAdmin: true,
      },
      send: (evt) => {
        if (evt.event !== "run_update") return;
        const status = evt.data["status"];
        if (typeof status === "string" && TERMINAL_RUN_STATUSES.has(status as RunStatus)) {
          finish();
        }
      },
    });

    // Close the subscribe-after-read race: the run may have gone terminal
    // between the caller's snapshot and the subscription above.
    void isRunTerminal(scope, runId)
      .then((terminal) => {
        if (terminal) finish();
      })
      .catch(() => {});
  });
}
