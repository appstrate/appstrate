// SPDX-License-Identifier: Apache-2.0

/**
 * B5/D4 — a huge run result is truncated with a pointer, never silently.
 *
 * The contract under test:
 *   - the threshold is 32 KB of SERIALIZED result, and it is a strict overrun
 *     (a payload landing exactly on the limit passes through untouched);
 *   - what survives is a USABLE head — enough to answer in the median case —
 *     plus `truncated: true` and the run id the whole result can be read from;
 *   - truncation is UNCONDITIONAL: it depends on nothing the platform had to
 *     write first, because the full payload is already durable in `runs.result`
 *     and `getRun` returns it. An earlier revision copied the payload into a
 *     dedicated document and skipped truncating whenever that best-effort copy
 *     was missing — i.e. the guard stopped guarding exactly when a result was
 *     big enough to matter. These tests pin the absence of that hole.
 */

import { describe, expect, it } from "bun:test";
import {
  RUN_RESULT_INLINE_MAX_BYTES,
  runAndWaitStepsWithDocuments,
  runResultExceedsInlineLimit,
  truncateRunAndWaitPayload,
  type RunAndWaitDocument,
} from "../src/run-and-wait-client.ts";

/**
 * A `{ output: { text } }` result whose JSON serialization is EXACTLY
 * `bytes` long — so the boundary can be probed one byte either side of the cap.
 */
function resultOfExactlyBytes(bytes: number): { output: { text: string } } {
  const envelope = JSON.stringify({ output: { text: "" } }).length;
  return { output: { text: "x".repeat(bytes - envelope) } };
}

const reportDocument: RunAndWaitDocument = {
  id: "doc_report001",
  uri: "document://doc_report001",
  name: "report.html",
  mime: "text/html",
  size: 22_846,
};

describe("run result inline limit", () => {
  it("measures the serialized result and only fires on a strict overrun", () => {
    expect(runResultExceedsInlineLimit(resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES))).toBe(
      false,
    );
    expect(runResultExceedsInlineLimit(resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 1))).toBe(
      true,
    );
  });

  it("does not fire on the sizes that produced the audited incident (9–11.6 KB)", () => {
    expect(runResultExceedsInlineLimit(resultOfExactlyBytes(9_057))).toBe(false);
    expect(runResultExceedsInlineLimit(resultOfExactlyBytes(11_583))).toBe(false);
  });

  it("reports false for an unserializable result rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(runResultExceedsInlineLimit(cyclic)).toBe(false);
    expect(runResultExceedsInlineLimit(undefined)).toBe(false);
  });
});

describe("truncateRunAndWaitPayload", () => {
  const base = { id: "run_1", packageId: "@acme/writer", status: "success", done: true };

  it("leaves a payload exactly on the limit untouched", () => {
    const payload = { ...base, result: resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES) };
    expect(truncateRunAndWaitPayload(payload)).toBe(payload);
  });

  it("truncates one byte over the limit, keeping a usable head and the run id", () => {
    const result = resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 1);
    const out = truncateRunAndWaitPayload({ ...base, result });

    // The full copy is gone from the transcript, and unmistakably so.
    expect(out).not.toHaveProperty("result");
    expect(out.truncated).toBe(true);
    expect(out.result_size_bytes).toBe(RUN_RESULT_INLINE_MAX_BYTES + 1);
    // Run identity survives — it IS the pointer, so it must.
    expect(out).toMatchObject({ id: "run_1", packageId: "@acme/writer", status: "success" });

    // The head is genuinely usable: exactly one cap's worth of bytes, and a
    // real prefix of the serialization (so it starts inside the payload's own
    // structure rather than at some re-encoded boundary).
    const head = out.result_head as string;
    expect(new TextEncoder().encode(head).length).toBe(RUN_RESULT_INLINE_MAX_BYTES);
    expect(JSON.stringify(result).startsWith(head)).toBe(true);
    expect(head.startsWith('{"output":{"text":"xxx')).toBe(true);
    // And the model is told what it is holding + how to reach the rest.
    expect(String(out.message)).toContain("result_head");
    expect(String(out.message)).toContain("getRun");
    expect(String(out.message)).toContain("run_1");
  });

  it("truncates regardless of what the run published — the guard never opts out", () => {
    // The removed spill design skipped truncation when its copy was absent.
    // Nothing the run did (or failed to do) may disarm the cap now.
    const payload = { ...base, result: resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 5_000) };
    expect(truncateRunAndWaitPayload(payload).truncated).toBe(true);
  });

  it("still truncates when the payload carries no run id, minus the id in the text", () => {
    const { id: _id, ...noId } = base;
    const out = truncateRunAndWaitPayload({
      ...noId,
      result: resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 1),
    });
    expect(out.truncated).toBe(true);
    expect(String(out.message)).toContain("getRun");
  });

  it("leaves a resultless payload alone", () => {
    const payload = { ...base };
    expect(truncateRunAndWaitPayload(payload)).toBe(payload);
  });
});

describe("run_and_wait terminal step", () => {
  async function terminalPayload(
    documents: RunAndWaitDocument[],
  ): Promise<Record<string, unknown>> {
    const bigResult = resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES * 2);
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/run")) return json({ id: "run_1", status: "pending" });
      if (url.includes("/api/documents")) {
        return json({ object: "list", data: documents, hasMore: false });
      }
      return json({ id: "run_1", packageId: "@acme/writer", status: "success", result: bigResult });
    }) as unknown as typeof fetch;

    const payloads: Record<string, unknown>[] = [];
    for await (const step of runAndWaitStepsWithDocuments(
      { kind: "agent", scope: "@acme", name: "writer" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    )) {
      payloads.push(step.payload);
    }
    return payloads.at(-1)!;
  }

  it("serves the truncated payload alongside the run's own documents", async () => {
    const terminal = await terminalPayload([reportDocument]);
    expect(terminal.truncated).toBe(true);
    expect(terminal).not.toHaveProperty("result");
    // The agent's deliverable is still listed and is untouched by truncation.
    expect(terminal.documents).toEqual([reportDocument]);
  });

  it("truncates a run that published NOTHING — the case the old design missed", async () => {
    const terminal = await terminalPayload([]);
    expect(terminal.truncated).toBe(true);
    expect(terminal).not.toHaveProperty("result");
    expect(terminal).not.toHaveProperty("documents");
  });
});
