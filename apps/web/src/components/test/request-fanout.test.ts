// SPDX-License-Identifier: Apache-2.0

/**
 * Guards on the three request patterns this codebase removed, each of which is
 * a one-line edit away from coming back:
 *
 *  1. the dashboard mounting `<RunList>` under a run query it already made
 *     (two `GET /api/runs` per page view, two `COUNT`s, for the same rows);
 *  2. the schedule CARD fetching a schedule's runs to count three numbers
 *     (N cards → N requests);
 *  3. the notification queries polling every 30s, which is only safe to slow
 *     down while the realtime stream reconciles them on reconnect — the SSE
 *     protocol has no replay, so dropping the reconnect-side invalidation would
 *     leave a badge stale for a full poll interval;
 *  4. the reconciliation running on the FIRST connect too, which issued every
 *     notification and chat-session query twice on every page load (#1678);
 *  5. the agent page fetching the agent's runs a second time, unpaginated and
 *     under a key of its own, to learn whether there is any (#1678);
 *  6. a launch refetching the run lists of the page it is leaving (#1678);
 *  7. a skill or MCP-server page reading the lists only an agent page shows.
 *
 * Source-scanned rather than rendered: these modules import the SPA's typed API
 * client, which uses `import.meta.glob` and cannot be evaluated by the bun test
 * runner (the same reason `file-preview.test.ts` scans its component).
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QueryClient } from "@tanstack/react-query";
import { broadRunKeys, createGapReconciler } from "../../hooks/use-global-run-sync.ts";

type InvalidateCall = { queryKey: readonly unknown[] } | { predicate: unknown };

/** A reconciler over a client that records what it is asked to refetch. */
function recordingReconciler() {
  const calls: InvalidateCall[] = [];
  const qc = {
    invalidateQueries: (filters: InvalidateCall) => {
      calls.push(filters);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  const reconciler = createGapReconciler(() => qc, 10_000);
  return {
    calls,
    /** Every key-addressed call, serialized. */
    keys: () =>
      calls.flatMap((call) => ("queryKey" in call ? [JSON.stringify(call.queryKey)] : [])),
    /** Open a stream over `scope`, as one run of the hook's effect does. */
    open: (scope = "org_1/spc_1") => reconciler.open("org_1", scope),
  };
}

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

/**
 * Source with comments removed. The removed patterns are NAMED in the comments
 * that explain why they were removed, so an absence assertion against the raw
 * file would fail on its own documentation.
 */
const code = (source: string) =>
  source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX comment expressions
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DASHBOARD = read("../../pages/dashboard.tsx");
const SCHEDULE_CARD = read("../schedule-card.tsx");
const RUN_LIST = read("../run-list.tsx");
const NOTIFICATIONS = read("../../hooks/use-notifications.ts");
const GLOBAL_SYNC = read("../../hooks/use-global-run-sync.ts");
const AGENT_ACTIONS = read("../package-detail/agent-actions.tsx");
const MUTATIONS = read("../../hooks/use-mutations.ts");

describe("dashboard reuses its own runs", () => {
  it("renders the presentational rows, not a second fetching list", () => {
    expect(DASHBOARD).toContain("<RunRows runs={runs.slice(0, RECENT_RUNS_COUNT)} />");
    // `<RunList …>` here is what issues the duplicate query.
    expect(code(DASHBOARD)).not.toMatch(/<RunList[\s/>]/);
  });

  it("keeps exactly one run query on the page", () => {
    expect([...DASHBOARD.matchAll(/usePaginatedRuns\(/g)]).toHaveLength(1);
  });

  it("still exposes a fetching RunList for the pages that page through runs", () => {
    // The split must not have turned the paginated list into a dead export:
    // /runs, the agent tab and the schedule detail all rely on it.
    expect(RUN_LIST).toContain("export function RunList(");
    expect(RUN_LIST).toContain("export function RunRows(");
  });
});

describe("schedule cards read their counters from the schedule", () => {
  it("does not fetch a schedule's runs per card", () => {
    expect(code(SCHEDULE_CARD)).not.toContain("useScheduleRuns");
    expect(code(SCHEDULE_CARD)).not.toContain("/runs");
  });

  it("reads the three counters served with the list payload", () => {
    expect(SCHEDULE_CARD).toContain("schedule.running_runs");
    expect(SCHEDULE_CARD).toContain("schedule.unread_count");
    expect(SCHEDULE_CARD).toContain("schedule.last_run_number");
  });
});

describe("agent page", () => {
  it("reads whether the agent has runs off the detail it already holds", () => {
    expect(code(AGENT_ACTIONS)).not.toMatch(/use(Paginated)?Runs\(/);
    expect(AGENT_ACTIONS).toContain("hasRuns={detail.last_run !== null}");
  });

  it("marks the run lists stale on launch without refetching the page being left", () => {
    const launch = MUTATIONS.slice(
      MUTATIONS.indexOf("function useRunAgent("),
      MUTATIONS.indexOf("export function useRunLauncher("),
    );
    const invalidations = [...code(launch).matchAll(/invalidateQueries\(([^)]*)\)/g)].map(
      (m) => m[1]!,
    );
    expect(invalidations).toEqual(['{ queryKey: paginatedRunsKeys.all, refetchType: "none" }']);
  });
});

describe("package pages other than an agent's", () => {
  // #1678: a skill page loaded the org's models and proxies, which only the
  // agent configuration tab shows.
  it("do not read the model and proxy lists", () => {
    const detail = read("../../pages/unified-package-detail.tsx");
    expect(detail).toContain('useProxies(type === "agent")');
    expect(detail).toContain('useModels(type === "agent")');
  });
});

describe("notification freshness", () => {
  it("polls as a backstop (5 min), on every notification query", () => {
    expect(NOTIFICATIONS).toContain("const NOTIFICATION_POLL_INTERVAL_MS = 300_000;");
    const intervals = [...NOTIFICATIONS.matchAll(/refetchInterval:\s*([^,\n]+)/g)].map(
      (m) => m[1]!,
    );
    expect(intervals).toHaveLength(3);
    expect(intervals.every((v) => v === "NOTIFICATION_POLL_INTERVAL_MS")).toBe(true);
  });

  // The load-bearing half: without this, slowing the poll down means a missed
  // terminal event leaves the badge wrong for five minutes.
  it("reconciles the badges on every SSE reconnect", () => {
    const { keys, open } = recordingReconciler();
    const stream = open();
    stream.connected(0);
    stream.connected(1_000);
    expect(keys()).toContain('["get","/api/notifications"]');
    expect(keys()).toContain('["get","/api/notifications/unread-count"]');
    expect(keys()).toContain('["get","/api/notifications/unread-counts-by-agent"]');
  });

  it("still invalidates them on a terminal run seen live", () => {
    expect(GLOBAL_SYNC).toContain("TERMINAL_RUN_STATUSES.has(status)");
    expect([...GLOBAL_SYNC.matchAll(/invalidateNotificationQueries\(/g)].length).toBeGreaterThan(1);
  });
});

describe("run cache reconciliation on reconnect", () => {
  // Same protocol gap as the badges, run side: `run_update` frames missed while
  // the stream was down left the page reading "running" under a bell that said
  // "finished".
  const BADGE = '["get","/api/notifications/unread-count"]';

  it("reconciles nothing on the first connect, which opens beside the mount's own queries", () => {
    const { calls, open } = recordingReconciler();
    open().connected(0);
    expect(calls).toHaveLength(0);
  });

  // A switch of org, space or persona creates its caches beside the new
  // stream, exactly as a page load does: reconciling there refetched everything
  // the switch had just fetched.
  it("reconciles nothing on the first connect after a change of scope", () => {
    const { calls, open } = recordingReconciler();
    open("org_1/spc_1").connected(0);
    open("org_1/spc_2").connected(1_000);
    expect(calls).toHaveLength(0);
  });

  // The effect also reopens the stream when only the grants changed: the
  // caches are the same ones, and nothing listened for them in between.
  it("reconciles on the first connect of a stream reopened over the same scope", () => {
    const { keys, open } = recordingReconciler();
    open("org_1/spc_1").connected(0);
    open("org_1/spc_1").connected(1_000);
    expect(keys()).toContain(BADGE);
  });

  // The mount's queries are as old as the whole backoff by the time a stream
  // finally opens: that first SUCCESSFUL connect is not the first attempt.
  it("reconciles on the first successful connect when an attempt failed before it", () => {
    const { keys, open } = recordingReconciler();
    const stream = open();
    stream.missed();
    stream.connected(0);
    expect(keys()).toContain(BADGE);
  });

  it("reconciles the run families on a reconnect, at most once per interval", () => {
    const { keys, calls, open } = recordingReconciler();
    const stream = open();
    stream.connected(0);
    stream.connected(20_000);
    for (const key of broadRunKeys("org_1")) expect(keys()).toContain(JSON.stringify(key));
    expect(keys()).toContain('["run"]');

    // A stream dropped again within the interval still owes the signal-only
    // families (badges, chat), not a second sweep of the run caches.
    const afterFirst = calls.length;
    stream.connected(21_000);
    const second = calls.slice(afterFirst);
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((call) => "queryKey" in call && call.queryKey[0] === "run")).toBe(false);
  });

  it("covers every run family except the logs, identically on both paths", () => {
    // One list feeds the per-event throttle AND the reconnect reconciliation,
    // so the latter cannot drift into a silent subset of the former.
    const keys = broadRunKeys("org_1").map((key) => JSON.stringify(key));
    expect(keys).toEqual([
      '["paginated-runs"]',
      '["agents","org_1"]',
      '["packages","agents","org_1"]',
      '["get","/api/runs"]',
    ]);
    // The run-detail page appends live frames into the log cache; refetching
    // it would drop the per-turn breadcrumbs it holds.
    expect(keys.some((key) => key.startsWith('["run-logs"'))).toBe(false);
  });
});
