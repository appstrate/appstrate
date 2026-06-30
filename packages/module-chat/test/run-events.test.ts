// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  buildRunPageHref,
  buildRunSseUrl,
  extractAgentLabel,
  extractRunId,
  extractRunPackageId,
  extractRunStatus,
  isRunLaunchOp,
  isTerminalStatus,
  mergeLogs,
  orgAppFromHeaders,
  parseLogListResponse,
  parseRunLogFrame,
  parseRunUpdateFrame,
  safeJsonParse,
  visibleLogEntries,
  type RunLogLine,
} from "../src/ui/run-events.ts";

describe("run-events helpers", () => {
  test("identifies run launch operations and terminal statuses", () => {
    expect(isRunLaunchOp("runAgent")).toBe(true);
    expect(isRunLaunchOp("runInline")).toBe(true);
    expect(isRunLaunchOp("run_and_wait")).toBe(true);
    expect(isRunLaunchOp("getRun")).toBe(false);

    expect(isTerminalStatus("success")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  test("extracts run id and status from invoke and run_and_wait results", () => {
    expect(extractRunId({ status: 201, body: { id: "run_body" } })).toBe("run_body");
    expect(extractRunId({ id: "run_top" })).toBe("run_top");
    expect(extractRunId({ id: "conn_1" })).toBeUndefined();

    expect(extractRunStatus({ status: 201, body: { status: "running" } })).toBe("running");
    expect(extractRunStatus({ id: "run_x", status: "success" })).toBe("success");
    expect(extractRunStatus({ status: 201 })).toBeUndefined();
  });

  test("extracts display labels and run links", () => {
    expect(extractAgentLabel({ path_params: { scope: "@acme", name: "writer" } })).toBe(
      "@acme/writer",
    );
    expect(extractAgentLabel({ kind: "inline", manifest: { display_name: "Tool" } })).toBe("Tool");
    expect(extractAgentLabel({ kind: "inline", manifest: {} })).toBe("Run inline");
    expect(extractAgentLabel({})).toBeUndefined();

    expect(extractRunPackageId({ body: { packageId: "@acme/writer" } })).toBe("@acme/writer");
    expect(extractRunPackageId({ packageId: "@acme/writer" })).toBe("@acme/writer");
    expect(extractRunPackageId({ body: { package_id: "@acme/snake" } })).toBe("@acme/snake");
    expect(extractRunPackageId({ package_id: "@acme/top-snake" })).toBe("@acme/top-snake");
    expect(buildRunPageHref("@acme/writer", "run_42")).toBe("/agents/@acme/writer/runs/run_42");
    expect(buildRunPageHref(undefined, "run_42")).toBeUndefined();
  });

  test("parses JSON, logs, and run updates", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("{bad")).toBeUndefined();

    const log = parseRunLogFrame(JSON.stringify({ id: 1, event: "log", message: "hello" }));
    expect(log?.message).toBe("hello");
    expect(parseRunLogFrame(JSON.stringify({ message: "missing id" }))).toBeUndefined();

    const update = parseRunUpdateFrame(
      JSON.stringify({
        id: "run_1",
        status: "running",
        packageId: "@inline/run",
        startedAt: "2026-06-30T00:00:00Z",
      }),
    );
    expect(update?.status).toBe("running");
    expect(update?.packageId).toBe("@inline/run");
    expect(parseRunUpdateFrame(JSON.stringify({ id: "run_1" }))).toBeUndefined();
  });

  test("parses, merges, and filters log rows", () => {
    const logs = parseLogListResponse({
      data: [
        { id: 2, event: "progress", message: "hidden" },
        { id: 1, event: "log", message: "first" },
        { id: 3, event: "log", data: { step: 2 } },
        { message: "bad" },
      ],
    });
    expect(logs.map((l) => l.id)).toEqual([2, 1, 3]);

    const merged = mergeLogs([{ id: 1, message: "old" }], [{ id: 1, message: "new" }, { id: 2 }]);
    expect(merged).toEqual([{ id: 1, message: "new" }, { id: 2 }]);

    expect(visibleLogEntries(logs as RunLogLine[])).toEqual([
      { id: 1, text: "first" },
      { id: 3, text: '{"step":2}' },
    ]);
  });

  test("builds SSE URLs from org/app headers", () => {
    expect(buildRunSseUrl({ runId: "run a/b", orgId: "o", applicationId: "a" })).toBe(
      "/api/realtime/runs/run%20a%2Fb?orgId=o&applicationId=a&verbose=true",
    );
    expect(
      buildRunSseUrl({ runId: "run_1", orgId: undefined, applicationId: "a" }),
    ).toBeUndefined();

    expect(orgAppFromHeaders({ "X-Org-Id": "o", "X-Application-Id": "a" })).toEqual({
      orgId: "o",
      applicationId: "a",
    });
    expect(orgAppFromHeaders({ "x-org-id": "o2", "x-application-id": "a2" })).toEqual({
      orgId: "o2",
      applicationId: "a2",
    });
  });
});
