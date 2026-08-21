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
 *     down while the realtime stream reconciles them on (re)connect — the SSE
 *     protocol has no replay, so dropping the reconnect-side invalidation would
 *     leave a badge stale for a full poll interval.
 *
 * Source-scanned rather than rendered: these modules import the SPA's typed API
 * client, which uses `import.meta.glob` and cannot be evaluated by the bun test
 * runner (the same reason `document-preview.test.ts` scans its component).
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const RUNS_TABLE = read("../runs-table.tsx");
const NOTIFICATIONS = read("../../hooks/use-notifications.ts");
const GLOBAL_SYNC = read("../../hooks/use-global-run-sync.ts");

describe("dashboard reuses its own runs", () => {
  it("renders the rows it already holds, not a second fetching list", () => {
    expect(DASHBOARD).toContain(
      "<RunsTable runs={runs.slice(0, RECENT_RUNS_COUNT)} agentName={agentName} />",
    );
    // `<RunList …>` here is what issues the duplicate query.
    expect(code(DASHBOARD)).not.toMatch(/<RunList[\s/>]/);
  });

  it("keeps exactly one run query on the page", () => {
    expect([...DASHBOARD.matchAll(/usePaginatedRuns\(/g)]).toHaveLength(1);
  });

  it("keeps the table free of queries, and the fetching list exported", () => {
    // The split must not have turned the paginated list into a dead export:
    // /runs, the agent tab and the schedule detail all rely on it. And the
    // table must stay row-taking — the day it fetches for itself, mounting it
    // under a page that already has the rows brings the duplicate query back.
    expect(RUN_LIST).toContain("export function RunList(");
    expect(RUNS_TABLE).toContain("export function RunsTable(");
    expect(code(RUNS_TABLE)).not.toContain("useQuery");
    expect(code(RUNS_TABLE)).not.toContain("usePaginatedRuns");
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
  it("reconciles the badges on every SSE (re)connect, before reading frames", () => {
    const connectStart = GLOBAL_SYNC.indexOf("const connectOnce = async () => {");
    const readerStart = GLOBAL_SYNC.indexOf("const reader = res.body.getReader();");
    expect(connectStart).toBeGreaterThan(-1);
    expect(readerStart).toBeGreaterThan(connectStart);

    const onConnect = GLOBAL_SYNC.slice(connectStart, readerStart);
    expect(onConnect).toContain("invalidateNotificationQueries(qcRef.current)");
  });

  it("still invalidates them on a terminal run seen live", () => {
    expect(GLOBAL_SYNC).toContain("TERMINAL_RUN_STATUSES.has(status)");
    expect([...GLOBAL_SYNC.matchAll(/invalidateNotificationQueries\(/g)].length).toBeGreaterThan(1);
  });
});
