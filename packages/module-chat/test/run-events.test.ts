// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runProducedFilesPath } from "@appstrate/core/run-and-wait-client";
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
  producedFilesFromFileList,
  publishedFilesFromLogs,
  shouldRaiseSweepDone,
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
      primary_document_id: "file_primary",
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
            id: "file_1",
            uri: "appfile://file_1",
            name: "report.html",
            mime: "text/html",
            size: 12,
          },
        ],
      }),
    ).toEqual([
      { id: "file_1", uri: "appfile://file_1", name: "report.html", mime: "text/html", size: 12 },
    ]);

    // Nested under the invoke_operation envelope's `body`.
    expect(
      extractRunFiles({
        body: { id: "run_1", files: [{ id: "file_2", uri: "appfile://file_2", name: "a.pdf" }] },
      }),
    ).toEqual([{ id: "file_2", uri: "appfile://file_2", name: "a.pdf" }]);

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
          file_id: "file_9",
          uri: "appfile://file_9",
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
        id: "file_9",
        uri: "appfile://file_9",
        name: "out.csv",
        mime: "text/csv",
        size: 40,
      },
    ]);
  });

  it("merges regular file lists without projecting any featured flag", () => {
    const persisted = [{ id: "file_1", uri: "appfile://file_1", name: "report" }];
    const live = [
      {
        id: "file_1",
        uri: "appfile://file_1",
        name: "report.html",
        mime: "text/html",
      },
      { id: "file_2", uri: "appfile://file_2", name: "data.json" },
    ];
    const merged = mergeRunFiles(persisted, live);
    expect(merged.map((d) => d.id)).toEqual(["file_1", "file_2"]);
    expect(merged[0]).toEqual({
      id: "file_1",
      uri: "appfile://file_1",
      name: "report.html",
      mime: "text/html",
    });
  });

  it("resolves a sent attachment's content to a downloadable file or inert", () => {
    // Image part: the converter puts the URI in the `image` field.
    expect(
      resolveAttachmentContent([
        { type: "image", image: "appfile://file_abcd1234", filename: "photo.png" },
      ]),
    ).toEqual({ kind: "file", id: "file_abcd1234" });

    // File part: the URI lives in the `data` field instead.
    expect(resolveAttachmentContent([{ type: "file", data: "appfile://file_efgh5678" }])).toEqual({
      kind: "file",
      id: "file_efgh5678",
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
  /** A settled run: terminal status, and the produced-file sweep completed. */
  const settled = { status: "success" as const, sweepDone: true };

  it("presents nothing when the run produced no file", () => {
    expect(autoPresentFile({ files: [], ...settled })).toBeUndefined();
  });

  it("presents the single produced file, with nothing declared by the agent", () => {
    expect(autoPresentFile({ files: [file("file_1")], ...settled })).toEqual(file("file_1"));
  });

  it("presents nothing when the run produced several files — the user picks", () => {
    const three = [file("file_1"), file("file_2"), file("file_3")];
    expect(autoPresentFile({ files: three, ...settled })).toBeUndefined();
  });

  it("waits for the run to settle: a mid-stream count of 1 is not the final count", () => {
    // Same first file, four moments of the same run. Only the last one — the
    // terminal status WITH the produced-file sweep completed — may present
    // anything.
    const one = [file("file_1")];
    expect(autoPresentFile({ files: one, status: "running", sweepDone: false })).toBeUndefined();
    expect(autoPresentFile({ files: one, status: undefined, sweepDone: false })).toBeUndefined();
    // Terminal, but the sweep that would reveal files 2 and 3 has not landed.
    // This is the exact window the old `!live` gate mistook for "settled": the
    // one-shot `GET /runs/:id` answers `success` while the SSE is still
    // handshaking, so `live` was still its initial `false`.
    expect(autoPresentFile({ files: one, status: "success", sweepDone: false })).toBeUndefined();
    expect(autoPresentFile({ files: one, status: "success", sweepDone: true })).toEqual(
      file("file_1"),
    );
  });

  it("still presents the single file of a run that failed", () => {
    // A failed run that nonetheless published one file has a result to show.
    expect(autoPresentFile({ files: [file("file_1")], status: "failed", sweepDone: true })).toEqual(
      file("file_1"),
    );
  });

  it("ignores a legacy `presentation` field on the log line", () => {
    // Three files, one of them flagged primary by an old runtime image. The
    // flag changes nothing: three produced files present nothing.
    const logs: RunLogLine[] = [
      { id: 1, event: "file", data: { file_id: "file_a", name: "a.md" } },
      {
        id: 2,
        event: "file",
        data: { file_id: "file_b", name: "b.md", presentation: "primary" },
      },
      { id: 3, event: "file", data: { file_id: "file_c", name: "c.md" } },
    ];
    const files = publishedFilesFromLogs(logs);
    expect(files.map((d) => d.id)).toEqual(["file_a", "file_b", "file_c"]);
    expect(autoPresentFile({ files, ...settled })).toBeUndefined();

    // And a lone file flagged `primary` is presented because it is the ONLY
    // one, not because it was flagged.
    const lone = publishedFilesFromLogs([logs[1]!]);
    expect(autoPresentFile({ files: lone, ...settled })?.id).toBe("file_b");
  });

  it("counts only publications: a run's input attachments are not produced files", () => {
    // Input files reach a run through its `input` payload, never as a
    // `file.published` frame — only the publish tool and the `outputs/`
    // sweep emit those. A run that consumed two inputs and produced one file
    // is a single-file run.
    const logs: RunLogLine[] = [
      { id: 1, event: "input", data: { file_id: "file_in_1", name: "brief.pdf" } },
      { id: 2, event: "log", message: "reading file_in_2" },
      { id: 3, event: "file", data: { file_id: "file_out", name: "report.md" } },
    ];
    const files = publishedFilesFromLogs(logs);
    expect(files.map((d) => d.id)).toEqual(["file_out"]);
    expect(autoPresentFile({ files, ...settled })?.id).toBe("file_out");

    // A run that only consumed inputs produced nothing to present.
    expect(
      autoPresentFile({ files: publishedFilesFromLogs(logs.slice(0, 2)), ...settled }),
    ).toBeUndefined();
  });

  it("leaves the card no reader of the retired agent-declared selection", () => {
    // A source-text grep, and deliberately only the NEGATIVE half of one — the
    // same rule the `useRunLogStream source guards` block below states, for the
    // same reason. There is no DOM harness in this repo, so the card cannot be
    // rendered; "this string is absent" is the one claim a grep answers
    // honestly, because it fails on the thing coming back and cannot pass by
    // luck of formatting.
    //
    // The positive assertions this case used to carry are gone — both species
    // the doctrine below names, and both were demonstrated on this card:
    //  - `toContain("autoPresentFile({ files, status: effectiveStatus, sweepDone })")`
    //    pinned one unwrapped call expression. Letting prettier rewrap it —
    //    zero behaviour change — failed it, while `const _x = autoPresentFile({…})`,
    //    a call whose result is discarded, would have passed. What it reached
    //    for is the rule itself, which the cases above test directly.
    //  - `toContain("producedFiles")` was already satisfied by the unrelated
    //    `producedFilesTruncated` further down the same file, so dropping the
    //    authoritative `/api/files` read out of the counted set — the real
    //    defect it was there to catch — left the whole suite green.
    const card = readFileSync(
      fileURLToPath(new URL("../src/ui/chat-run-progress-card.tsx", import.meta.url)),
      "utf8",
    );
    expect(card).not.toContain("primary");
    expect(card).not.toContain("presentation:");
  });
});

/**
 * The authoritative produced-file source (issue #1177 follow-up). The log
 * window is capped and ascending, so the end-of-run publication frames of a
 * chatty run fall outside it; `GET /api/files?run_id=…` is the source that
 * cannot be truncated away, and it is what the run page reads too.
 */
describe("producedFilesFromFileList", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "file_x",
    name: "x.md",
    mime: "text/markdown",
    size: 3,
    purpose: "agent_output",
    run_id: "run_1",
    ...over,
  });

  it("maps the list rows to chips, deriving the canonical uri from the id", () => {
    const payload = { object: "list", data: [row({ id: "file_a", name: "a.md" })] };
    expect(producedFilesFromFileList(payload, "run_1")).toEqual({
      files: [
        { id: "file_a", uri: "appfile://file_a", name: "a.md", mime: "text/markdown", size: 3 },
      ],
      hasMore: false,
    });
  });

  it("reports a truncated page instead of hiding it", () => {
    // The route clamps `limit` to 100 and answers `hasMore` with no cursor
    // field. Discarding it truncated a >100-file run's chips row silently.
    // It never endangers the auto-present rule — a truncated page holds at
    // least 100 rows, never exactly 1 — so surfacing it is the whole fix.
    const payload = { object: "list", data: [row({ id: "file_a" })], hasMore: true };
    expect(producedFilesFromFileList(payload, "run_1")?.hasMore).toBe(true);
  });

  it("drops a file the run only CONSUMED, even though it is `agent_output`", () => {
    // `GET /api/files?run_id=X` answers the run's whole container: a file
    // chained in from an earlier run via `appfile://` is listed here and still
    // carries `purpose: "agent_output"` — it was produced by that earlier run.
    // Counting it would make a one-file run look like a two-file run and
    // silently switch the auto-present rule off.
    const payload = {
      data: [
        row({ id: "file_in", run_id: "run_0" }),
        row({ id: "file_out" }),
        row({ id: "file_upload", purpose: "user_upload" }),
      ],
    };
    expect(producedFilesFromFileList(payload, "run_1")?.files.map((f) => f.id)).toEqual([
      "file_out",
    ]);
  });

  it("answers `undefined` on a malformed or errored payload — no evidence at all", () => {
    // Union-never-subtract: nothing is added to the card, which stays on its
    // log-derived chips. And `undefined` is NOT an empty page: the completion
    // signal turns on telling "the run produced nothing" apart from "the read
    // did not answer" (see `shouldRaiseSweepDone`).
    expect(producedFilesFromFileList(undefined, "run_1")).toBeUndefined();
    expect(producedFilesFromFileList({ error: "boom" }, "run_1")).toBeUndefined();
    expect(producedFilesFromFileList({ data: "nope" }, "run_1")).toBeUndefined();
  });

  it("treats an envelope listing ZERO files as a real, complete answer", () => {
    // A run that produced nothing is a legitimate outcome, not a failure.
    expect(producedFilesFromFileList({ object: "list", data: [] }, "run_1")).toEqual({
      files: [],
      hasMore: false,
    });
  });
});

/**
 * A publication frame with no name. The sink writes `name: null` whenever the
 * emitter omitted one (`appstrate-event-sink.ts` → `file.published`), so this
 * is a shape that exists on the wire, not a hypothetical.
 */
describe("nameless publication frames", () => {
  it("keeps the file, with a placeholder name, instead of dropping it", () => {
    const logs: RunLogLine[] = [
      { id: 1, type: "result", event: "file", data: { file_id: "file_1", name: null } },
      { id: 2, type: "result", event: "file", data: { file_id: "file_2", name: "b.md" } },
    ];
    const files = publishedFilesFromLogs(logs);
    // Two produced files, so nothing is auto-presented. Dropping the nameless
    // one would leave a count of 1 and open the WRONG file.
    expect(files.map((f) => f.id)).toEqual(["file_1", "file_2"]);
    expect(files[0]?.name).toBe("file");
    expect(autoPresentFile({ files, status: "success", sweepDone: true })).toBeUndefined();
  });

  it("still refuses a frame with no id at all — there is nothing to open", () => {
    expect(publishedFilesFromLogs([{ id: 1, event: "file", data: { name: "orphan.md" } }])).toEqual(
      [],
    );
  });
});

/**
 * The completion signal the auto-present rule waits on.
 *
 * The decision itself — "given how the authoritative read and the log sweep
 * turned out, and the run status, may the flag be raised?" — is
 * `shouldRaiseSweepDone`, and it is tested here against real inputs, failures
 * included. It used to be an inlined `finally` in `use-run-log-stream.ts` that
 * could only be pinned by grepping that file's SOURCE TEXT; those assertions
 * were not coverage. They passed unchanged for a hook that swallowed a 500 from
 * `/api/files` and raised the flag anyway, and one of them (`setSweepDone(true)`
 * appears exactly twice) actively blocked the fix.
 */
describe("shouldRaiseSweepDone", () => {
  const settled = { status: "success", producedFileRead: "ok", logSweep: "ok" } as const;

  it("raises the flag when the run is over and both reads answered", () => {
    expect(shouldRaiseSweepDone(settled)).toBe(true);
  });

  it("refuses to settle when the authoritative read did not answer", () => {
    // THE defect this rule exists for. `/api/files` answering 500 or 401 is an
    // ordinary transient failure, and the read that swallowed it still
    // "finished" — which is not the same as having produced evidence.
    expect(shouldRaiseSweepDone({ ...settled, producedFileRead: "failed" })).toBe(false);
    expect(shouldRaiseSweepDone({ ...settled, producedFileRead: "not-attempted" })).toBe(false);
  });

  it("refuses to settle when the final log sweep was attempted and failed", () => {
    // An errored sweep yields `[]`, indistinguishable from a run that wrote no
    // frames — and the card's set is the UNION of the frames and the read.
    expect(shouldRaiseSweepDone({ ...settled, logSweep: "failed" })).toBe(false);
  });

  it("does not require a log sweep the settle path never attempted", () => {
    // The no-tail path (no org/app context, or no EventSource) reads
    // `/api/files` and nothing else; the authoritative read IS the evidence
    // there, and demanding a sweep that was never fired would leave that path
    // permanently unsettled.
    expect(shouldRaiseSweepDone({ ...settled, logSweep: "not-attempted" })).toBe(true);
  });

  it("never settles a run that is not over", () => {
    // A mid-stream count of 1 is not the final count: a run publishing three
    // files emits them one at a time.
    expect(shouldRaiseSweepDone({ ...settled, status: "running" })).toBe(false);
    expect(shouldRaiseSweepDone({ ...settled, status: undefined })).toBe(false);
  });

  it("does not settle a two-file run on the one file the log window kept", () => {
    // End to end, the reachable failure: a run publishes 2 files, the second
    // `file.published` frame falls outside the capped log window, and
    // `/api/files` — the read that exists to cover exactly that case — answers
    // 500. Settling here auto-opens the FIRST of two files.
    const fromLogs = publishedFilesFromLogs([
      { id: 1, type: "result", event: "file", data: { file_id: "file_1", name: "a.md" } },
    ]);
    expect(fromLogs).toHaveLength(1);
    const sweepDone = shouldRaiseSweepDone({
      status: "success",
      producedFileRead: "failed",
      logSweep: "ok",
    });
    expect(sweepDone).toBe(false);
    expect(autoPresentFile({ files: fromLogs, status: "success", sweepDone })).toBeUndefined();
  });
});

/**
 * The two guards that survive as source-text greps. There is NO DOM harness in
 * this repo (no jsdom, no happy-dom, no testing-library), so `useRunLogStream`
 * cannot be instantiated and these two facts have no other observer. Every
 * POSITIVE assertion this block used to carry is gone: asserting that a source
 * file contains `await readProducedFiles();` passed for the defect above and
 * failed on a rename — the opposite of coverage.
 */
describe("useRunLogStream source guards", () => {
  const hook = readFileSync(
    fileURLToPath(new URL("../src/ui/use-run-log-stream.ts", import.meta.url)),
    "utf8",
  );

  it("no longer exposes a liveness flag anything could mistake for settlement", () => {
    // `live` started `false`, flipped only on the SSE handshake (losing the
    // race against the two plain GETs fired in the same tick) and never flipped
    // at all when no SSE was opened. Nothing but a grep can see it come back.
    expect(hook).not.toContain("setLive");
    expect(hook).not.toContain("es.onopen");
  });

  it("reads the produced-file set from the authoritative endpoint, filtered", () => {
    // Two halves, because neither alone can see the whole claim. The hook no
    // longer spells the URL out — it and `fetchRunFiles` share one builder — so
    // the invariant itself is asserted directly on that builder, and only the
    // fact that the hook REACHES it stays a grep: without a DOM harness nothing
    // can observe the call. Dropping `purpose` (or the `run_id` this list is
    // keyed on) would list files the run merely CONSUMED and silently switch
    // the auto-present rule off.
    expect(hook).toContain("runProducedFilesPath(runId)");
    const path = runProducedFilesPath("run_abc");
    expect(path).toContain("purpose=agent_output");
    expect(path).toContain("run_id=run_abc");
  });
});

/**
 * Pre-#1177 wire shapes are NOT read any more.
 *
 * They used to be: a chat session replaying logs written before the rename
 * would find `event: "document"` frames carrying `document_id`, and
 * `run_and_wait` results carrying their list under `documents`. No such row or
 * payload exists, so the readers were narrowed to the canonical spellings.
 *
 * Asserted rather than deleted, because the failure mode is silent in both
 * directions: a reader that quietly re-accepted the old tag would resurrect a
 * second wire vocabulary, and the tests that used to prove the old one worked
 * would have simply disappeared with nothing recording the decision.
 */
describe("retired `document` wire shapes", () => {
  const settled = { status: "success" as const, sweepDone: true };

  it('ignores a pre-rename `event: "document"` log frame', () => {
    const logs: RunLogLine[] = [
      {
        id: 1,
        type: "result",
        event: "document",
        data: { document_id: "file_legacy1", name: "rapport.md", mime: "text/markdown", size: 12 },
      },
    ];
    expect(publishedFilesFromLogs(logs)).toEqual([]);
  });

  it('reads the canonical `event: "file"` frame — the positive control', () => {
    // Without this, the assertion above would pass just as well if
    // `publishedFilesFromLogs` were broken outright.
    const logs: RunLogLine[] = [
      {
        id: 1,
        type: "result",
        event: "file",
        data: { file_id: "file_new1", name: "rapport.md", mime: "text/markdown", size: 12 },
      },
    ];
    expect(publishedFilesFromLogs(logs)).toEqual([
      {
        id: "file_new1",
        uri: "appfile://file_new1",
        name: "rapport.md",
        mime: "text/markdown",
        size: 12,
      },
    ]);
  });

  it("counts only canonical frames when deriving the presentation rule", () => {
    // A run whose only publication used the retired tag presents nothing —
    // there is no file, not a file that fails to present.
    const legacyOnly = publishedFilesFromLogs([
      { id: 1, event: "document", data: { document_id: "file_only", name: "only.md" } },
    ]);
    expect(legacyOnly).toEqual([]);
    expect(autoPresentFile({ files: legacyOnly, ...settled })).toBeUndefined();

    // Mixed tags therefore count as ONE, and that one presents.
    const mixed = publishedFilesFromLogs([
      { id: 1, event: "document", data: { document_id: "file_old", name: "old.md" } },
      { id: 2, event: "file", data: { file_id: "file_new", name: "new.md" } },
    ]);
    expect(mixed.map((f) => f.id)).toEqual(["file_new"]);
    expect(autoPresentFile({ files: mixed, ...settled })?.id).toBe("file_new");
  });

  it("treats a retired `document://` attachment URI as inert, not as a file", () => {
    // The scheme stopped being parseable when the id prefix moved to `file_`:
    // a part persisted before #1177 addresses a `doc_` id, so there is nothing
    // for it to resolve to. It degrades to `inert` with the raw URI carried
    // along, the same as an unmaterialized `upload://` — never to a `file`
    // chip pointing at an id that does not exist.
    expect(
      resolveAttachmentContent([{ type: "image", image: "document://file_abcd1234" }]),
    ).toEqual({ kind: "inert", uri: "document://file_abcd1234" });
    expect(resolveAttachmentContent([{ type: "file", data: "document://doc_efgh5678" }])).toEqual({
      kind: "inert",
      uri: "document://doc_efgh5678",
    });
  });

  it("ignores a tool-result item keyed by `document_id`", () => {
    expect(
      extractRunFiles({
        body: { id: "run_1", files: [{ document_id: "file_x", name: "x.md" }] },
      }),
    ).toEqual([]);
    // Positive control: the same item under the canonical key is read.
    expect(
      extractRunFiles({ body: { id: "run_1", files: [{ id: "file_x", name: "x.md" }] } }),
    ).toEqual([{ id: "file_x", uri: "appfile://file_x", name: "x.md" }]);
  });

  it("ignores a tool-result list sitting under `documents`", () => {
    expect(
      extractRunFiles({
        id: "run_1",
        status: "success",
        done: true,
        documents: [{ id: "file_1", name: "report.html" }],
      }),
    ).toEqual([]);
    expect(
      extractRunFiles({ body: { id: "run_1", documents: [{ id: "file_2", name: "a.pdf" }] } }),
    ).toEqual([]);
  });

  it("reads the canonical `files` key and ignores a `documents` sibling", () => {
    expect(
      extractRunFiles({
        files: [{ id: "file_new", name: "new.md" }],
        documents: [{ id: "file_old", name: "old.md" }],
      }).map((f) => f.id),
    ).toEqual(["file_new"]);
  });
});
