// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  autoPresentFile,
  buildRunPageHref,
  buildRunSseUrl,
  extractAgentLabel,
  extractRunFiles,
  extractRunId,
  extractRunPackageId,
  extractRunStatus,
  isRunAutoPresentEligible,
  isRunLaunchOp,
  isTerminalStatus,
  mergeLogs,
  mergeRunFiles,
  orgAppFromHeaders,
  parseLogListResponse,
  parseRunLogFrame,
  parseRunResource,
  parseRunUpdateFrame,
  publishedFilesFromLogs,
  resolveAttachmentContent,
  safeJsonParse,
  runStatusLineKey,
  visibleLogEntries,
  type RunLogLine,
} from "../src/ui/run-events.ts";

describe("run-events helpers", () => {
  it("identifies run launch operations and terminal statuses", () => {
    expect(isRunLaunchOp("runAgent")).toBe(true);
    expect(isRunLaunchOp("runInline")).toBe(true);
    expect(isRunLaunchOp("run_and_wait")).toBe(true);
    expect(isRunLaunchOp("getRun")).toBe(false);

    expect(isTerminalStatus("success")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isRunAutoPresentEligible("pending", "pending")).toBe(true);
    expect(isRunAutoPresentEligible("running", "running")).toBe(true);
    expect(isRunAutoPresentEligible("success", "success")).toBe(false);
    expect(isRunAutoPresentEligible("running", "success")).toBe(false);

    // Keys, not sentences — the host translator renders them (no literal text
    // ships from this module).
    expect(runStatusLineKey("success")).toBe("run.status.success");
    expect(runStatusLineKey("failed")).toBe("run.status.failed");
    expect(runStatusLineKey("timeout")).toBe("run.status.timeout");
    expect(runStatusLineKey("cancelled")).toBe("run.status.cancelled");
    expect(runStatusLineKey(undefined)).toBe("run.status.done");
  });

  it("extracts run id and status from invoke and run_and_wait results", () => {
    expect(extractRunId({ status: 201, body: { id: "run_body" } })).toBe("run_body");
    expect(extractRunId({ id: "run_top" })).toBe("run_top");
    expect(extractRunId({ id: "conn_1" })).toBeUndefined();

    expect(extractRunStatus({ status: 201, body: { status: "running" } })).toBe("running");
    expect(extractRunStatus({ id: "run_x", status: "success" })).toBe("success");
    expect(extractRunStatus({ status: 201 })).toBeUndefined();
  });

  it("extracts display labels and run links", () => {
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

  it("parses JSON, logs, and run updates", () => {
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

  it("parses a GET /runs/:id run resource down to the lifecycle subset", () => {
    // A running run's resource carries extra fields (agent_scope, cost, …) that
    // the lifecycle subset drops. This is what seeds the badge on a mid-run
    // reload so it reads the live status, not the persisted "pending".
    const run = parseRunResource({
      id: "run_1",
      status: "running",
      packageId: "@inline/run",
      startedAt: "2026-06-30T00:00:00Z",
      completedAt: null,
      duration: null,
      // Retired field a not-yet-deployed server may still send (#1177): dropped
      // like any other extra, never a parse failure.
      primary_document_id: "doc_primary",
      agentScope: "@inline",
      cost: 0,
    });
    expect(run?.status).toBe("running");
    expect(run?.packageId).toBe("@inline/run");
    expect(run?.startedAt).toBe("2026-06-30T00:00:00Z");
    expect(run).not.toHaveProperty("primary_document_id");
    // Malformed body (no status) → undefined, so the seed is skipped.
    expect(parseRunResource({ id: "run_1" })).toBeUndefined();
    expect(parseRunResource(null)).toBeUndefined();
  });

  it("parses, merges, and filters log rows", () => {
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

  it("extracts published files from the persisted run_and_wait result", () => {
    // Top-level (run_and_wait tool result shape).
    expect(
      extractRunFiles({
        id: "run_1",
        status: "success",
        done: true,
        files: [
          {
            id: "doc_1",
            uri: "appfile://doc_1",
            name: "report.html",
            mime: "text/html",
            size: 12,
          },
        ],
      }),
    ).toEqual([
      { id: "doc_1", uri: "appfile://doc_1", name: "report.html", mime: "text/html", size: 12 },
    ]);

    // Nested under the invoke_operation envelope's `body`.
    expect(
      extractRunFiles({
        body: { id: "run_1", files: [{ id: "doc_2", uri: "appfile://doc_2", name: "a.pdf" }] },
      }),
    ).toEqual([{ id: "doc_2", uri: "appfile://doc_2", name: "a.pdf" }]);

    // No files → empty.
    expect(extractRunFiles({ id: "run_1", status: "success" })).toEqual([]);
    expect(extractRunFiles(null)).toEqual([]);
  });

  it("extracts published files from live file log frames", () => {
    const logs: RunLogLine[] = [
      { id: 1, event: "log", message: "working" },
      {
        id: 2,
        type: "result",
        event: "file",
        data: {
          file_id: "doc_9",
          uri: "appfile://doc_9",
          name: "out.csv",
          mime: "text/csv",
          size: 40,
          // Legacy field on historical log lines (#1177) — read past, never
          // projected into the file and never a parse failure.
          presentation: "primary",
        },
      },
      { id: 3, event: "progress" },
    ];
    expect(publishedFilesFromLogs(logs)).toEqual([
      {
        id: "doc_9",
        uri: "appfile://doc_9",
        name: "out.csv",
        mime: "text/csv",
        size: 40,
      },
    ]);
  });

  it("merges regular file lists without projecting any featured flag", () => {
    const persisted = [{ id: "doc_1", uri: "appfile://doc_1", name: "report" }];
    const live = [
      {
        id: "doc_1",
        uri: "appfile://doc_1",
        name: "report.html",
        mime: "text/html",
      },
      { id: "doc_2", uri: "appfile://doc_2", name: "data.json" },
    ];
    const merged = mergeRunFiles(persisted, live);
    expect(merged.map((d) => d.id)).toEqual(["doc_1", "doc_2"]);
    expect(merged[0]).toEqual({
      id: "doc_1",
      uri: "appfile://doc_1",
      name: "report.html",
      mime: "text/html",
    });
  });

  it("resolves a sent attachment's content to a downloadable file or inert", () => {
    // Image part: the converter puts the URI in the `image` field.
    expect(
      resolveAttachmentContent([
        { type: "image", image: "appfile://doc_abcd1234", filename: "photo.png" },
      ]),
    ).toEqual({ kind: "file", id: "doc_abcd1234" });

    // File part: the URI lives in the `data` field instead.
    expect(resolveAttachmentContent([{ type: "file", data: "appfile://doc_efgh5678" }])).toEqual({
      kind: "file",
      id: "doc_efgh5678",
    });

    // Just-sent optimistic upload:// (not yet materialized to appfile://) →
    // inert, but the raw URI is kept so the staged-image cache can be probed.
    expect(resolveAttachmentContent([{ type: "file", data: "upload://upl_abcd1234" }])).toEqual({
      kind: "inert",
      uri: "upload://upl_abcd1234",
    });

    // Malformed / missing / empty content → inert (never throws).
    expect(resolveAttachmentContent([{ type: "image", image: "not-a-uri" }])).toEqual({
      kind: "inert",
      uri: "not-a-uri",
    });
    expect(resolveAttachmentContent([{ type: "file" }])).toEqual({ kind: "inert" });
    expect(resolveAttachmentContent([])).toEqual({ kind: "inert" });
    expect(resolveAttachmentContent(undefined)).toEqual({ kind: "inert" });
  });

  it("builds SSE URLs from org/app headers", () => {
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

/**
 * The derived presentation rule that replaced the agent-declared
 * `presentation: "primary"` (issue #1177). The count of files the run PRODUCED
 * is the whole rule — nothing the model says takes part in it.
 */
describe("autoPresentFile", () => {
  const file = (id: string): { id: string; uri: string; name: string } => ({
    id,
    uri: `appfile://${id}`,
    name: `${id}.md`,
  });
  /** A settled run: terminal status, live tail already closed after its sweep. */
  const settled = { status: "success" as const, live: false };

  it("presents nothing when the run produced no file", () => {
    expect(autoPresentFile({ files: [], ...settled })).toBeUndefined();
  });

  it("presents the single produced file, with nothing declared by the agent", () => {
    expect(autoPresentFile({ files: [file("doc_1")], ...settled })).toEqual(file("doc_1"));
  });

  it("presents nothing when the run produced several files — the user picks", () => {
    const three = [file("doc_1"), file("doc_2"), file("doc_3")];
    expect(autoPresentFile({ files: three, ...settled })).toBeUndefined();
  });

  it("waits for the run to settle: a mid-stream count of 1 is not the final count", () => {
    // Same first file, three moments of the same run. Only the last one — the
    // terminal status WITH the live tail closed, i.e. the final log sweep
    // merged — may present anything.
    const one = [file("doc_1")];
    expect(autoPresentFile({ files: one, status: "running", live: true })).toBeUndefined();
    expect(autoPresentFile({ files: one, status: undefined, live: true })).toBeUndefined();
    // Terminal, but the sweep that would reveal files 2 and 3 has not landed.
    expect(autoPresentFile({ files: one, status: "success", live: true })).toBeUndefined();
    expect(autoPresentFile({ files: one, status: "success", live: false })).toEqual(file("doc_1"));
  });

  it("still presents the single file of a run that failed", () => {
    // A failed run that nonetheless published one file has a result to show.
    expect(autoPresentFile({ files: [file("doc_1")], status: "failed", live: false })).toEqual(
      file("doc_1"),
    );
  });

  it("ignores a legacy `presentation` field on the log line", () => {
    // Three files, one of them flagged primary by an old runtime image. The
    // flag changes nothing: three produced files present nothing.
    const logs: RunLogLine[] = [
      { id: 1, event: "file", data: { file_id: "doc_a", name: "a.md" } },
      {
        id: 2,
        event: "file",
        data: { file_id: "doc_b", name: "b.md", presentation: "primary" },
      },
      { id: 3, event: "file", data: { file_id: "doc_c", name: "c.md" } },
    ];
    const files = publishedFilesFromLogs(logs);
    expect(files.map((d) => d.id)).toEqual(["doc_a", "doc_b", "doc_c"]);
    expect(autoPresentFile({ files, ...settled })).toBeUndefined();

    // And a lone file flagged `primary` is presented because it is the ONLY
    // one, not because it was flagged.
    const lone = publishedFilesFromLogs([logs[1]!]);
    expect(autoPresentFile({ files: lone, ...settled })?.id).toBe("doc_b");
  });

  it("counts only publications: a run's input attachments are not produced files", () => {
    // Input files reach a run through its `input` payload, never as a
    // `file.published` frame — only the publish tool and the `outputs/`
    // sweep emit those. A run that consumed two inputs and produced one file
    // is a single-file run.
    const logs: RunLogLine[] = [
      { id: 1, event: "input", data: { file_id: "doc_in_1", name: "brief.pdf" } },
      { id: 2, event: "log", message: "reading doc_in_2" },
      { id: 3, event: "file", data: { file_id: "doc_out", name: "report.md" } },
    ];
    const files = publishedFilesFromLogs(logs);
    expect(files.map((d) => d.id)).toEqual(["doc_out"]);
    expect(autoPresentFile({ files, ...settled })?.id).toBe("doc_out");

    // A run that only consumed inputs produced nothing to present.
    expect(
      autoPresentFile({ files: publishedFilesFromLogs(logs.slice(0, 2)), ...settled }),
    ).toBeUndefined();
  });

  it("is the card's only auto-presentation path, fired at most once", () => {
    // No DOM in this runner, so the wiring is asserted on the source: the card
    // must derive its candidate from the rule (not from a server field), must
    // present through the host opener only, and must keep the once-only ref —
    // a file published after the panel opened never closes or swaps it.
    const card = readFileSync(
      fileURLToPath(new URL("../src/ui/chat-run-progress-card.tsx", import.meta.url)),
      "utf8",
    );
    expect(card).toContain("autoPresentFile({ files, status: effectiveStatus, live })");
    expect(card).toContain("if (hasAutoPresented.current) return;");
    expect(card).toContain("hasAutoPresented.current = true;");
    // The retired agent-declared selection has no reader left anywhere.
    expect(card).not.toContain("primary");
    expect(card).not.toContain("presentation:");
  });
});

/**
 * Pre-#1177 wire compatibility. A chat session opened today replays run logs
 * and tool results written BEFORE the rename: they tag the frame
 * `event: "document"`, carry `document_id`, and address the file with the
 * `document://` scheme. Every one of those must still surface a chip — a reader
 * that only knows the new spelling would show an old conversation with no
 * files at all, and nothing anywhere would report an error.
 */
describe("legacy `document` wire shapes", () => {
  const settled = { status: "success" as const, live: false };

  it('still produces a chip from a pre-rename `event: "document"` log frame', () => {
    const logs: RunLogLine[] = [
      {
        id: 1,
        type: "result",
        event: "document",
        data: { document_id: "doc_legacy1", name: "rapport.md", mime: "text/markdown", size: 12 },
      },
    ];
    expect(publishedFilesFromLogs(logs)).toEqual([
      {
        id: "doc_legacy1",
        // No `uri` on the frame — derived through core's `fileUri()`, which
        // emits the canonical scheme even for a legacy id.
        uri: "appfile://doc_legacy1",
        name: "rapport.md",
        mime: "text/markdown",
        size: 12,
      },
    ]);
  });

  it("keeps a legacy frame's own `document://` URI verbatim", () => {
    const logs: RunLogLine[] = [
      {
        id: 1,
        event: "document",
        data: { document_id: "doc_legacy2", uri: "document://doc_legacy2", name: "a.pdf" },
      },
    ];
    expect(publishedFilesFromLogs(logs)[0]?.uri).toBe("document://doc_legacy2");
  });

  it("feeds the derived presentation rule from legacy frames alone", () => {
    // One legacy publication = a single-file run, exactly as a new-tag frame.
    const one = publishedFilesFromLogs([
      { id: 1, event: "document", data: { document_id: "doc_only", name: "only.md" } },
    ]);
    expect(autoPresentFile({ files: one, ...settled })?.id).toBe("doc_only");

    // Mixed old/new tags in the same run still count as two — nothing presented.
    const mixed = publishedFilesFromLogs([
      { id: 1, event: "document", data: { document_id: "doc_old", name: "old.md" } },
      { id: 2, event: "file", data: { file_id: "doc_new", name: "new.md" } },
    ]);
    expect(mixed.map((f) => f.id)).toEqual(["doc_old", "doc_new"]);
    expect(autoPresentFile({ files: mixed, ...settled })).toBeUndefined();
  });

  it("resolves a historical `document://` attachment URI", () => {
    // Persisted chat messages from before the rename carry the old scheme in
    // their file parts; core's `parseFileUri` accepts both, and nothing here
    // re-implements scheme parsing with a hardcoded prefix.
    expect(resolveAttachmentContent([{ type: "image", image: "document://doc_abcd1234" }])).toEqual(
      { kind: "file", id: "doc_abcd1234" },
    );
    expect(resolveAttachmentContent([{ type: "file", data: "document://doc_efgh5678" }])).toEqual({
      kind: "file",
      id: "doc_efgh5678",
    });
  });

  it("still reads a persisted tool result whose items carry `document_id`", () => {
    expect(
      extractRunFiles({
        body: { id: "run_1", files: [{ document_id: "doc_x", name: "x.md" }] },
      }),
    ).toEqual([{ id: "doc_x", uri: "appfile://doc_x", name: "x.md" }]);
  });
});
