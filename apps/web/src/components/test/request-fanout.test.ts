// SPDX-License-Identifier: Apache-2.0

/**
 * Guards on the request patterns this codebase removed, each of which is
 * a one-line edit away from coming back:
 *
 *  1. the dashboard mounting `<RunList>` under a run query it already made
 *     (two `GET /api/runs` per page view, two `COUNT`s, for the same rows);
 *  2. the notification queries polling every 30s, which is only safe to slow
 *     down while the realtime stream reconciles them on reconnect — the SSE
 *     protocol has no replay, so dropping the reconnect-side invalidation would
 *     leave a badge stale for a full poll interval;
 *  3. the reconciliation running on the FIRST connect too, which issued every
 *     notification and chat-session query twice on every page load;
 *  4. the agent page fetching the agent's runs a second time, unpaginated and
 *     under a key of its own, to learn whether there is any;
 *  5. a launch refetching the run lists of the page it is leaving;
 *  6. a skill or integration page reading the lists only an agent page shows.
 *
 * Mostly source-scanned: a pattern that is a page's composition (which list
 * mounts under which) has no observable besides its source. The agent page's
 * run probe is rendered instead, and read off the query cache it fills.
 */

import { describe, it, expect } from "bun:test";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The stores read `localStorage` at module init, and the agent page's hook reads the app config.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});

const { broadRunKeys, trackStreamGaps } = await import("../../hooks/use-global-run-sync.ts");
const { ACROSS_SPACES, removeOrgScopedQueries } = await import("../../lib/query-keys.ts");
const { renderInSpace } = await import("../../test/space-context.ts");
const { packageDetailQueryOptions } = await import("../../hooks/use-packages.ts");
const { useAgentActions } = await import("../package-detail/use-agent-actions.tsx");

type InvalidateCall = { queryKey: readonly unknown[] } | { predicate: unknown };

/** A real cache whose invalidations are recorded instead of run. */
function recordingReconciler() {
  const calls: InvalidateCall[] = [];
  const qc = new QueryClient();
  qc.invalidateQueries = ((filters: InvalidateCall) => {
    calls.push(filters);
    return Promise.resolve();
  }) as QueryClient["invalidateQueries"];
  return {
    qc,
    calls,
    /** Every key-addressed call, serialized. */
    keys: () =>
      calls.flatMap((call) => ("queryKey" in call ? [JSON.stringify(call.queryKey)] : [])),
    /** Open a stream over `scope`, as one run of the hook's effect does. */
    open: (scope = "org_1/spc_1") => trackStreamGaps(() => qc, "org_1", scope),
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
const RUN_LIST = read("../run-list.tsx");
const DASHBOARD_CONTENT = read("../../pages/dashboard-content.tsx");
const RUNS_TABLE = read("../runs-table.tsx");
const GLOBAL_SYNC = read("../../hooks/use-global-run-sync.ts");
const AGENT_ACTIONS = read("../package-detail/agent-actions.tsx");
const ACTIONS_DROPDOWN = read("../package-detail/package-actions-dropdown.tsx");
const MUTATIONS = read("../../hooks/use-mutations.ts");

describe("dashboard reuses its own runs", () => {
  it("renders the rows it already holds, not a second fetching list", () => {
    // The page hands its own rows down and the presentation layer trims them
    // (rendered in `pages/test/dashboard.test.tsx`); what must never appear on
    // either side is the FETCHING list, which would issue a second query for
    // rows the page is already holding.
    expect(code(DASHBOARD)).not.toMatch(/<RunList[\s/>]/);
    expect(code(DASHBOARD_CONTENT)).not.toMatch(/<RunList[\s/>]/);
    expect(DASHBOARD_CONTENT).toContain("runs.slice(0, limit)");
  });

  it("keeps exactly one run query on the page", () => {
    expect([...DASHBOARD.matchAll(/useFirstRunsPage\(/g)]).toHaveLength(1);
  });

  it("keeps the table free of queries, and the fetching list exported", () => {
    // The split must not have turned the paginated list into a dead export:
    // /runs, the agent tab and the schedule detail all rely on it. And the
    // table must stay row-taking — the day it fetches for itself, mounting it
    // under a page that already has the rows brings the duplicate query back.
    expect(RUN_LIST).toContain("export function RunList(");
    expect(RUNS_TABLE).toContain("export function RunsTable(");
    expect(code(RUNS_TABLE)).not.toContain("useQuery");
    expect(code(RUNS_TABLE)).not.toContain("useRuns");
  });
});

const PACKAGE_ID = "@acme/reporter";
const RUN_DEEDS = ["agents:read", "agents:run", "runs:delete", "runs:read-all"];
const agentSpace = (id: string, isDefault = false) => ({
  id,
  object: "space",
  orgId: "org_1",
  access: "member",
  permissions: RUN_DEEDS,
  personal: false,
  isDefault,
  name: id,
  icon: null,
  color: null,
  role: null,
});

/**
 * Renders the agent page's actions hook over a detail read in `spc_a` (where the agent last ran
 * when `lastRun`), and returns the cache it filled plus the « Supprimer les runs » verdict.
 */
function agentPage({ overview, lastRun }: { overview: boolean; lastRun: boolean }) {
  const qc = new QueryClient();
  qc.setQueryData(
    ["orgs"],
    [{ id: "org_1", name: "Acme", slug: "acme", role: "member", permissions: [] }],
  );
  qc.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }], {
    object: "list",
    hasMore: false,
    data: [agentSpace("spc_a", true), agentSpace("spc_b"), agentSpace("spc_c")],
  });
  qc.setQueryData(
    packageDetailQueryOptions("agent", { orgId: "org_1", spaceId: "spc_a" }, PACKAGE_ID).queryKey,
    {
      id: PACKAGE_ID,
      source: "local",
      display_name: "Rapporteur",
      dependencies: { skills: [], integrations: [] },
      running_runs: 0,
      last_run: lastRun ? { id: "run_1", status: "success" } : null,
      space_ids: ["spc_a", "spc_b", "spc_c"],
      home_space_id: "spc_a",
      active: true,
    },
  );
  let clearRunsOffered: boolean | undefined;
  function Probe() {
    const { dropdown } = useAgentActions({
      packageId: PACKAGE_ID,
      isHistoricalVersion: false,
      downloadVersion: "1.0.0",
      downloadPackage: () => {},
      downloadBundle: () => {},
      onCreateVersion: () => {},
    });
    clearRunsOffered = dropdown?.agent?.clearRuns.offered;
    return null;
  }
  renderInSpace(createElement(Probe), { overview, queryClient: qc });
  /** The run queries the hook built: each key, and whether it may fetch. */
  const runQueries = qc
    .getQueryCache()
    .findAll({ queryKey: ["paginated-runs"] })
    .map((query) => ({
      key: query.queryKey,
      enabled: (query.options as { enabled?: unknown }).enabled !== false,
    }));
  return { clearRunsOffered, runQueries };
}

describe("agent page", () => {
  it("keeps the presentation free of run queries", () => {
    expect(code(AGENT_ACTIONS)).not.toMatch(/use(FirstRunsPage|Runs)\(/);
    expect(code(ACTIONS_DROPDOWN)).not.toMatch(/use(FirstRunsPage|Runs)\(/);
  });

  it("reads whether the agent has runs off the detail it already holds, with a space selected", () => {
    const ran = agentPage({ overview: false, lastRun: true });
    expect(ran.clearRunsOffered).toBe(true);
    // No run list is read to learn it: whatever the hook builds stays switched off.
    expect(ran.runQueries.filter((query) => query.enabled)).toEqual([]);

    const never = agentPage({ overview: false, lastRun: false });
    expect(never.clearRunsOffered).toBe(false);
    expect(never.runQueries.filter((query) => query.enabled)).toEqual([]);
  });

  it("reads it across spaces in « Tous les espaces », never one probe per space", () => {
    // The hidden space's detail says it ran; across spaces nothing is known yet, so nothing is
    // offered on the hidden space's word.
    const { clearRunsOffered, runQueries } = agentPage({ overview: true, lastRun: true });
    expect(clearRunsOffered).toBe(false);
    const enabled = runQueries.filter((query) => query.enabled);
    // The latest run and the runs in flight, both across spaces: two reads for three spaces.
    expect(enabled).toHaveLength(2);
    for (const { key } of enabled) expect(key[2]).toBe(ACROSS_SPACES);
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
  // The org's models and proxies are shown only by an agent's settings. The
  // page itself reads neither: the agent settings view and the model alert
  // (agents only) each read their own.
  it("do not read the model and proxy lists", () => {
    const detail = read("../../pages/unified-package-detail.tsx");
    expect(detail).not.toContain("useProxies(");
    expect(detail).not.toContain("useModels(");
    expect(detail).toContain('{type === "agent" && <ModelRequiredAlert');
  });
});

describe("notification freshness", () => {
  // One space's feed: the stream keeps it live, the poll is a backstop. Across spaces the feed
  // polls with the other spanning lists (`across-spaces-polling.test.tsx`).
  // The poll itself (5 min in one space, the lists' pace across spaces) is read off the queries
  // the hooks build: `hooks/test/across-spaces-polling.test.tsx`.

  // The load-bearing half: without this, slowing the poll down means a missed
  // terminal event leaves the badge wrong for five minutes.
  it("reconciles the badges on every SSE reconnect", () => {
    const { keys, open } = recordingReconciler();
    const stream = open();
    stream.connected(0);
    stream.connected(1_000);
    expect(keys()).toContain('["get","/api/notifications"]');
    expect(keys()).toContain('["get","/api/notifications/unread-count"]');
  });

  // A failed run lands in the bell, so a terminal frame re-reads the feed.
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
  it("reconciles nothing on the first connect over a scope no stream covered yet", () => {
    const { calls, open } = recordingReconciler();
    open("org_1/spc_1").connected(0);
    open("org_1/spc_2").connected(1_000);
    expect(calls).toHaveLength(0);
  });

  // Back on a scope within `staleTime`, its caches are served as they were
  // left, and no stream listened for them meanwhile.
  it("reconciles a scope a stream covered, left, and comes back to", () => {
    const { keys, open } = recordingReconciler();
    open("org_1/spc_1").connected(0);
    open("org_1/spc_2").connected(1_000);
    open("org_1/spc_1").connected(2_000);
    expect(keys()).toContain(BADGE);
  });

  // The memory must outlive the cache's own collection delay: a stream that
  // stayed up longer than that still leaves a gap behind when it reopens.
  it("still knows a covered scope after the cache's collection delay", async () => {
    const calls: unknown[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 5 } } });
    qc.invalidateQueries = (filters) => {
      calls.push(filters);
      return Promise.resolve();
    };
    trackStreamGaps(() => qc, "org_1", "org_1/spc_1").connected(0);
    expect(qc.getQueryDefaults(["realtime-covered", "org_1/spc_1"]).gcTime).toBe(Infinity);

    await new Promise((resolve) => setTimeout(resolve, 40));
    trackStreamGaps(() => qc, "org_1", "org_1/spc_1").connected(1_000);
    expect(calls.length).toBeGreaterThan(0);
  });

  // StrictMode's first effect run, or a switch faster than the round trip.
  it("keeps no trace of a stream aborted before it connected", () => {
    const { calls, open } = recordingReconciler();
    open("org_1/spc_1");
    open("org_1/spc_1").connected(0);
    expect(calls).toHaveLength(0);
  });

  // The memory lives in the cache it speaks for: an org switch or a role
  // preview removes every query, and the scope is new again.
  it("forgets a scope whose caches were wiped", () => {
    const { qc, calls, open } = recordingReconciler();
    open("org_1/spc_1").connected(0);
    removeOrgScopedQueries(qc);
    open("org_1/spc_1").connected(1_000);
    expect(calls).toHaveLength(0);
  });

  // Seen in the browser on a switch back to a space: the mount read of each
  // badge was cancelled by the reconciliation and issued a second time.
  it("lets a read already in flight finish instead of issuing it again", async () => {
    const qc = new QueryClient();
    const key = ["get", "/api/notifications/unread-count", { params: {} }];
    let fetches = 0;
    let settle: (count: number) => void = () => {};
    new QueryObserver(qc, {
      queryKey: key,
      queryFn: () => {
        fetches++;
        return new Promise<number>((resolve) => (settle = resolve));
      },
    }).subscribe(() => {});
    const reopen = () => {
      const stream = trackStreamGaps(() => qc, "org_1", "org_1/spc_1");
      stream.missed();
      stream.connected(0);
    };

    reopen();
    expect(fetches).toBe(1);

    // Once that read has landed, the next gap does refetch it.
    settle(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    reopen();
    expect(fetches).toBe(2);
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
