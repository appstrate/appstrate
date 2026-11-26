// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ConversationToolCall } from "@appstrate/module-chat/conversation-tools";
import { SUMMARY_ROWS, failedCalls, summaryModel } from "./summary-model";

let seq = 0;
function call(overrides: Partial<ConversationToolCall> = {}): ConversationToolCall {
  seq += 1;
  return {
    toolCallId: `call_${seq}`,
    messageId: "msg_1",
    turn: 1,
    toolName: "invoke_operation",
    input: {},
    output: {},
    status: "success",
    lookup: false,
    ...overrides,
  };
}

const run = (id: string) => ({ id });
const counted = <T>(rows: T[], total = rows.length) => ({ rows, total });

describe("failedCalls", () => {
  it("keeps the failures only, latest first, a failed lookup included", () => {
    const first = call({ status: "error", toolName: "search" });
    const ok = call();
    const denied = call({ status: "denied" });
    const last = call({ status: "error" });
    expect(failedCalls([first, ok, denied, last], new Set())).toEqual([last, first]);
  });

  it("leaves a failed launch to its run only when that run is among the failed ones", () => {
    const launch = call({ status: "error", toolName: "run_and_wait", runId: "run_1" });
    expect(failedCalls([launch], new Set(["run_1"]))).toEqual([]);
    expect(failedCalls([launch], new Set())).toEqual([launch]);
  });
});

describe("summaryModel", () => {
  it("leaves every section out of a conversation that did nothing", () => {
    expect(
      summaryModel({
        calls: [],
        runs: counted([]),
        failedRuns: counted([]),
        files: { rows: [], hasMore: false },
      }),
    ).toEqual({ attention: null, runs: null, files: null, actions: null });
  });

  it("shows « À vérifier » only when something failed, runs first, counted once", () => {
    const failedRun = run("run_f");
    const failedLookup = call({ status: "error", toolName: "describe" });
    const failedLaunch = call({ status: "error", runId: "run_f" });
    const model = summaryModel({
      calls: [failedLookup, failedLaunch, call()],
      runs: counted([failedRun]),
      failedRuns: counted([failedRun], 4),
    });
    expect(model.attention).toEqual({
      runs: [failedRun],
      calls: [failedLookup],
      count: 5,
      moreRuns: true,
      moreCalls: false,
    });
  });

  it("leaves a failed call to its run when that run is past the rows drawn", () => {
    // Four failed runs read, three drawn: the call of the fourth is still that run's failure.
    const failedRuns = ["run_4", "run_3", "run_2", "run_1"].map(run);
    const launchOfFourth = call({ status: "error", runId: "run_1" });
    const model = summaryModel({
      calls: [launchOfFourth],
      runs: counted(failedRuns),
      failedRuns: counted(failedRuns),
    });
    expect(model.attention).toEqual({
      runs: failedRuns.slice(0, SUMMARY_ROWS),
      calls: [],
      count: 4,
      moreRuns: true,
      moreCalls: false,
    });
  });

  it("counts every failed call on its own while the failed runs cannot be read", () => {
    const launch = call({ status: "error", runId: "run_f" });
    expect(summaryModel({ calls: [launch], runs: counted([run("run_f")]) }).attention).toEqual({
      runs: [],
      calls: [launch],
      count: 1,
      moreRuns: false,
      moreCalls: false,
    });
  });

  it("keeps a failed call whose run did not fail: the call's failure is its own", () => {
    // A wait cut short while its run goes on: the run is listed, not among the failed ones.
    const cutShort = call({ status: "error", toolName: "run_and_wait", runId: "run_live" });
    const model = summaryModel({
      calls: [cutShort],
      runs: counted([run("run_live")]),
      failedRuns: counted([]),
    });
    expect(model.attention).toEqual({
      runs: [],
      calls: [cutShort],
      count: 1,
      moreRuns: false,
      moreCalls: false,
    });
  });

  it("draws at most its rows of each failure kind, the count holding them all", () => {
    const failures = Array.from({ length: 5 }, () => call({ status: "error" }));
    const model = summaryModel({ calls: failures });
    expect(model.attention?.calls).toHaveLength(SUMMARY_ROWS);
    expect(model.attention?.count).toBe(5);
    expect(model.attention?.runs).toEqual([]);
    expect(model.attention?.moreCalls).toBe(true);
    expect(model.attention?.moreRuns).toBe(false);
  });

  it("counts the runs with the server's total, not the rows it read", () => {
    const rows = [run("run_3"), run("run_2"), run("run_1")];
    expect(summaryModel({ calls: [], runs: counted(rows, 240) }).runs).toEqual({
      rows,
      total: 240,
      more: true,
    });
    expect(summaryModel({ calls: [], runs: counted(rows) }).runs?.more).toBe(false);
  });

  it("counts no files: whether more follow is the server's `hasMore`", () => {
    const rows = [{ id: "file_1" }];
    expect(summaryModel({ calls: [], files: { rows, hasMore: true } }).files).toEqual({
      rows,
      more: true,
    });
    expect(summaryModel({ calls: [], files: { rows, hasMore: false } }).files?.more).toBe(false);
  });

  it("lists the actions latest first, lookups apart, with their count", () => {
    const calls = [call(), call({ lookup: true }), call(), call(), call()];
    const actions = summaryModel({ calls }).actions;
    expect(actions?.total).toBe(4);
    expect(actions?.more).toBe(true);
    expect(actions?.rows).toEqual([calls[4]!, calls[3]!, calls[2]!]);
  });

  it("leaves out a group whose list the reader cannot read", () => {
    const model = summaryModel({ calls: [call()] });
    expect(model.runs).toBeNull();
    expect(model.files).toBeNull();
    expect(model.attention).toBeNull();
    expect(model.actions?.rows).toHaveLength(1);
  });
});
