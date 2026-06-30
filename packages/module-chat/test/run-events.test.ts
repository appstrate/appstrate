// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  buildRunSseUrl,
  extractAgentLabel,
  extractRunId,
  extractRunStatus,
  isRunLaunchOp,
  isTerminalStatus,
  lastLogText,
  logLineText,
  maxLogId,
  mergeLogs,
  orgAppFromHeaders,
  parseLogListResponse,
  parseRunLogFrame,
  parseRunUpdateFrame,
  safeJsonParse,
  type RunLogLine,
} from "../src/ui/run-events.ts";

describe("isRunLaunchOp", () => {
  test("accepts the three launch ops", () => {
    expect(isRunLaunchOp("runAgent")).toBe(true);
    expect(isRunLaunchOp("runInline")).toBe(true);
    expect(isRunLaunchOp("run_and_wait")).toBe(true);
  });
  test("rejects others and undefined", () => {
    expect(isRunLaunchOp("getRun")).toBe(false);
    expect(isRunLaunchOp("initiateIntegrationConnect")).toBe(false);
    expect(isRunLaunchOp(undefined)).toBe(false);
    expect(isRunLaunchOp("")).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  test("terminal set", () => {
    for (const s of ["success", "failed", "timeout", "cancelled"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  test("non-terminal", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus("bogus")).toBe(false);
  });
});

describe("extractRunId", () => {
  test("reads body.id from the invoke_operation envelope", () => {
    const result = { status: 201, body: { id: "run_abc123", status: "pending" } };
    expect(extractRunId(result)).toBe("run_abc123");
  });
  test("reads a top-level id (run_and_wait shape)", () => {
    expect(extractRunId({ id: "run_top", status: "success" })).toBe("run_top");
  });
  test("unwraps an MCP text-content envelope (JSON string in text part)", () => {
    const result = {
      content: [
        { type: "text", text: JSON.stringify({ status: 201, body: { id: "run_wrapped" } }) },
      ],
    };
    expect(extractRunId(result)).toBe("run_wrapped");
  });
  test("unwraps a bare JSON string", () => {
    expect(extractRunId(JSON.stringify({ body: { id: "run_str" } }))).toBe("run_str");
  });
  test("ignores non-run ids (connection id must not open a run panel)", () => {
    expect(extractRunId({ body: { id: "conn_xyz" } })).toBeUndefined();
    expect(extractRunId({ id: "pkg_1" })).toBeUndefined();
  });
  test("undefined when no id present or malformed", () => {
    expect(extractRunId({ status: 500, body: { error: "boom" } })).toBeUndefined();
    expect(extractRunId(null)).toBeUndefined();
    expect(extractRunId("not json")).toBeUndefined();
    expect(extractRunId(42)).toBeUndefined();
  });
  test("prefers body.id over a top-level id", () => {
    expect(extractRunId({ id: "run_top", body: { id: "run_body" } })).toBe("run_body");
  });
});

describe("extractRunStatus", () => {
  test("reads body.status from the invoke envelope", () => {
    expect(extractRunStatus({ status: 201, body: { id: "run_x", status: "pending" } })).toBe(
      "pending",
    );
  });
  test("reads top-level status (run_and_wait terminal result)", () => {
    expect(extractRunStatus({ id: "run_x", status: "success" })).toBe("success");
  });
  test("prefers body.status over the envelope's numeric http status", () => {
    // The envelope's top-level `status` is the HTTP code (number) — must not win.
    expect(extractRunStatus({ status: 201, body: { status: "running" } })).toBe("running");
  });
  test("undefined when absent", () => {
    expect(extractRunStatus({ status: 201, body: { id: "run_x" } })).toBeUndefined();
    expect(extractRunStatus(null)).toBeUndefined();
  });
});

describe("extractAgentLabel", () => {
  test("agent id from invoke_operation path_params", () => {
    expect(
      extractAgentLabel({
        operation_id: "runAgent",
        path_params: { scope: "@acme", name: "writer" },
      }),
    ).toBe("@acme/writer");
  });
  test("agent id from run_and_wait scope/name", () => {
    expect(extractAgentLabel({ kind: "agent", scope: "@acme", name: "writer" })).toBe(
      "@acme/writer",
    );
  });
  test("inline manifest display_name then name", () => {
    expect(extractAgentLabel({ kind: "inline", manifest: { display_name: "My Tool" } })).toBe(
      "My Tool",
    );
    expect(extractAgentLabel({ kind: "inline", manifest: { name: "tmp" } })).toBe("tmp");
  });
  test("generic 'Run inline' when inline has no manifest name", () => {
    expect(extractAgentLabel({ kind: "inline", manifest: {} })).toBe("Run inline");
    expect(extractAgentLabel({ operation_id: "runInline" })).toBe("Run inline");
  });
  test("undefined when nothing identifiable", () => {
    expect(extractAgentLabel({})).toBeUndefined();
    expect(extractAgentLabel(undefined)).toBeUndefined();
    expect(extractAgentLabel({ operation_id: "runAgent" })).toBeUndefined();
  });
});

describe("logLineText", () => {
  test("prefers message", () => {
    expect(logLineText({ id: 1, message: "hi", event: "ev", data: { a: 1 } })).toBe("hi");
  });
  test("falls back to event then data", () => {
    expect(logLineText({ id: 1, event: "started" })).toBe("started");
    expect(logLineText({ id: 1, data: "raw" })).toBe("raw");
    expect(logLineText({ id: 1, data: { a: 1 } })).toBe('{"a":1}');
  });
  test("empty string when nothing displayable", () => {
    expect(logLineText({ id: 1 })).toBe("");
    expect(logLineText({ id: 1, message: null, event: null, data: null })).toBe("");
  });
});

describe("lastLogText", () => {
  test("most recent non-empty line", () => {
    expect(
      lastLogText([
        { id: 1, message: "a" },
        { id: 2, message: "b" },
      ]),
    ).toBe("b");
  });
  test("skips trailing empty lines", () => {
    expect(lastLogText([{ id: 1, message: "a" }, { id: 2 }, { id: 3, data: null }])).toBe("a");
  });
  test("undefined on empty / all-empty", () => {
    expect(lastLogText([])).toBeUndefined();
    expect(lastLogText([{ id: 1 }])).toBeUndefined();
  });
});

describe("safeJsonParse", () => {
  test("parses valid json", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  test("undefined on garbage", () => {
    expect(safeJsonParse("{nope")).toBeUndefined();
  });
});

describe("parseRunLogFrame", () => {
  test("parses a well-formed run_log frame", () => {
    const raw = JSON.stringify({
      id: 7,
      runId: "run_x",
      orgId: "org_1",
      applicationId: "app_1",
      type: "agent",
      level: "info",
      event: null,
      message: "hello",
      data: { foo: "bar" },
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    const line = parseRunLogFrame(raw);
    expect(line?.id).toBe(7);
    expect(line?.message).toBe("hello");
    expect(line?.level).toBe("info");
  });
  test("tolerates the stripped-payload sentinel string in data", () => {
    const raw = JSON.stringify({
      id: 1,
      level: "info",
      message: null,
      data: "[payload too large]",
    });
    expect(parseRunLogFrame(raw)?.data).toBe("[payload too large]");
  });
  test("undefined when id is missing", () => {
    expect(parseRunLogFrame(JSON.stringify({ level: "info", message: "x" }))).toBeUndefined();
  });
  test("undefined on malformed json", () => {
    expect(parseRunLogFrame("{bad")).toBeUndefined();
  });
});

describe("parseRunUpdateFrame", () => {
  test("parses a run_update frame", () => {
    const raw = JSON.stringify({ id: "run_x", status: "running", error: null });
    expect(parseRunUpdateFrame(raw)?.status).toBe("running");
  });
  test("undefined when status missing", () => {
    expect(parseRunUpdateFrame(JSON.stringify({ id: "run_x" }))).toBeUndefined();
  });
});

describe("parseLogListResponse", () => {
  test("extracts the data array", () => {
    const body = {
      object: "list",
      data: [
        { id: 1, level: "info", message: "a" },
        { id: 2, level: "warn", message: "b" },
      ],
      hasMore: false,
    };
    const logs = parseLogListResponse(body);
    expect(logs.map((l) => l.id)).toEqual([1, 2]);
  });
  test("drops malformed rows but keeps valid ones", () => {
    const body = { data: [{ id: 1, message: "ok" }, { message: "no id" }, { id: 3 }] };
    expect(parseLogListResponse(body).map((l) => l.id)).toEqual([1, 3]);
  });
  test("empty array on non-list body", () => {
    expect(parseLogListResponse(null)).toEqual([]);
    expect(parseLogListResponse({ data: "nope" })).toEqual([]);
    expect(parseLogListResponse({})).toEqual([]);
  });
});

describe("mergeLogs", () => {
  const a: RunLogLine = { id: 1, message: "a" };
  const b: RunLogLine = { id: 2, message: "b" };
  const c: RunLogLine = { id: 3, message: "c" };

  test("dedups overlapping ids (history + live tail)", () => {
    const merged = mergeLogs([a, b], [b, c]);
    expect(merged.map((l) => l.id)).toEqual([1, 2, 3]);
  });
  test("keeps ascending order regardless of arrival order", () => {
    const merged = mergeLogs([c], [a, b]);
    expect(merged.map((l) => l.id)).toEqual([1, 2, 3]);
  });
  test("incoming wins on id collision (latest content)", () => {
    const updated: RunLogLine = { id: 2, message: "b-updated" };
    const merged = mergeLogs([a, b], [updated]);
    expect(merged.find((l) => l.id === 2)?.message).toBe("b-updated");
  });
  test("returns existing reference-equal when nothing incoming", () => {
    const existing = [a, b];
    expect(mergeLogs(existing, [])).toBe(existing);
  });
});

describe("maxLogId", () => {
  test("highest id", () => {
    expect(maxLogId([{ id: 3 }, { id: 9 }, { id: 5 }])).toBe(9);
  });
  test("zero on empty", () => {
    expect(maxLogId([])).toBe(0);
  });
});

describe("buildRunSseUrl", () => {
  test("builds a verbose per-run url", () => {
    const url = buildRunSseUrl({ runId: "run_x", orgId: "org_1", applicationId: "app_1" });
    expect(url).toBe("/api/realtime/runs/run_x?orgId=org_1&applicationId=app_1&verbose=true");
  });
  test("url-encodes the run id", () => {
    const url = buildRunSseUrl({ runId: "run a/b", orgId: "o", applicationId: "a" });
    expect(url).toContain("/api/realtime/runs/run%20a%2Fb?");
  });
  test("undefined when org or app missing", () => {
    expect(
      buildRunSseUrl({ runId: "run_x", orgId: undefined, applicationId: "a" }),
    ).toBeUndefined();
    expect(
      buildRunSseUrl({ runId: "run_x", orgId: "o", applicationId: undefined }),
    ).toBeUndefined();
  });
});

describe("orgAppFromHeaders", () => {
  test("reads canonical-case headers", () => {
    expect(orgAppFromHeaders({ "X-Org-Id": "o", "X-Application-Id": "a" })).toEqual({
      orgId: "o",
      applicationId: "a",
    });
  });
  test("reads lower-case headers", () => {
    expect(orgAppFromHeaders({ "x-org-id": "o2", "x-application-id": "a2" })).toEqual({
      orgId: "o2",
      applicationId: "a2",
    });
  });
  test("undefined fields when absent", () => {
    expect(orgAppFromHeaders({})).toEqual({ orgId: undefined, applicationId: undefined });
    expect(orgAppFromHeaders(undefined)).toEqual({ orgId: undefined, applicationId: undefined });
  });
});
