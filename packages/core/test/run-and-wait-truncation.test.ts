// SPDX-License-Identifier: Apache-2.0

/**
 * B5/D4 — a huge run result is truncated with a pointer, never silently.
 *
 * The contract under test:
 *   - the threshold is 32 KB of SERIALIZED result, and it is a strict overrun
 *     (a payload landing exactly on the limit passes through untouched);
 *   - what survives is a USABLE head — enough to answer in the median case —
 *     plus `truncated: true` and a `document://` pointer at the full copy;
 *   - the pointer is the platform's spill document, found in the same
 *     `documents` list the terminal step already carries (no extra request);
 *   - with NO spill document there is no truncation at all: losing data
 *     silently would be worse than a large tool result.
 */

import { describe, expect, it } from "bun:test";
import {
  RUN_RESULT_INLINE_MAX_BYTES,
  RUN_RESULT_SPILL_DOCUMENT_NAME,
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

const spillDocument: RunAndWaitDocument = {
  id: "doc_spill0001",
  uri: "document://doc_spill0001",
  name: RUN_RESULT_SPILL_DOCUMENT_NAME,
  mime: "application/json",
  size: 40_000,
};

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
    expect(truncateRunAndWaitPayload(payload, [spillDocument])).toBe(payload);
  });

  it("truncates one byte over the limit, keeping a usable head and a pointer", () => {
    const result = resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 1);
    const out = truncateRunAndWaitPayload({ ...base, result }, [reportDocument, spillDocument]);

    // The full copy is gone from the transcript, and unmistakably so.
    expect(out).not.toHaveProperty("result");
    expect(out.truncated).toBe(true);
    expect(out.result_size_bytes).toBe(RUN_RESULT_INLINE_MAX_BYTES + 1);
    // The pointer is the spill document, not the agent's own report.
    expect(out.full_document_uri).toBe(spillDocument.uri);
    // Run identity survives — the model can still act on the run itself.
    expect(out).toMatchObject({ id: "run_1", packageId: "@acme/writer", status: "success" });

    // The head is genuinely usable: exactly one cap's worth of bytes, and a
    // real prefix of the serialization (so it starts inside the payload's own
    // structure rather than at some re-encoded boundary).
    const head = out.result_head as string;
    expect(new TextEncoder().encode(head).length).toBe(RUN_RESULT_INLINE_MAX_BYTES);
    expect(JSON.stringify(result).startsWith(head)).toBe(true);
    expect(head.startsWith('{"output":{"text":"xxx')).toBe(true);
    // And the model is told what it is holding + where the rest is.
    expect(String(out.message)).toContain("result_head");
    expect(String(out.message)).toContain("full_document_uri");
  });

  it("does NOT truncate when no spill document exists — no silent data loss", () => {
    const payload = { ...base, result: resultOfExactlyBytes(RUN_RESULT_INLINE_MAX_BYTES + 5_000) };
    expect(truncateRunAndWaitPayload(payload, [reportDocument])).toBe(payload);
    expect(truncateRunAndWaitPayload(payload, [])).toBe(payload);
  });

  it("leaves a resultless payload alone", () => {
    const payload = { ...base };
    expect(truncateRunAndWaitPayload(payload, [spillDocument])).toBe(payload);
  });
});

describe("run_and_wait terminal step (pointer resolves end to end)", () => {
  it("serves the truncated payload with the spill document listed alongside it", async () => {
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
        return json({ object: "list", data: [spillDocument, reportDocument], hasMore: false });
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

    const terminal = payloads.at(-1)!;
    expect(terminal.truncated).toBe(true);
    expect(terminal).not.toHaveProperty("result");
    expect(terminal.full_document_uri).toBe("document://doc_spill0001");
    // The pointer resolves within the list the model already has in hand.
    const listed = terminal.documents as RunAndWaitDocument[];
    expect(listed.find((d) => d.uri === terminal.full_document_uri)?.name).toBe(
      RUN_RESULT_SPILL_DOCUMENT_NAME,
    );
  });
});
