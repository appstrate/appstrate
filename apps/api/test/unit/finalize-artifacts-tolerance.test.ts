// SPDX-License-Identifier: Apache-2.0

/**
 * Finalize ingest tolerance for the `artifacts` summary.
 *
 * `POST /api/runs/:runId/events/finalize` reports the outcome of an
 * ALREADY-FINISHED run: the agent loop is over, there is no retry left. A 400
 * there is not a validation win, it is a lost run - the container cannot
 * finalize, the row stays `running`, and the watchdog eventually synthesises a
 * timeout/failure for a run that actually succeeded.
 *
 * `artifacts` is a purely cosmetic partial-deliverables signal, and a runtime
 * image newer than the platform can still legitimately send a field the
 * platform has never heard of: the trio tag rule refuses that pairing at boot,
 * but it is blind to a floating tag rebuilt on one side, to a digest-pinned
 * ref, and to a platform with no build identity. This guards that such a
 * payload still finalizes.
 */

import { describe, it, expect } from "bun:test";
import { RunResultSchema } from "../../src/routes/runs-events.ts";

/** A minimal, valid terminal payload. */
const BASE = { status: "success" as const, output: { ok: true } };

describe("finalize artifacts tolerance", () => {
  it("accepts a well-formed summary unchanged", () => {
    const parsed = RunResultSchema.safeParse({
      ...BASE,
      artifacts: { status: "partial", published: 2, failed: [{ name: "a.txt", code: "conflict" }] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.artifacts).toEqual({
      status: "partial",
      published: 2,
      failed: [{ name: "a.txt", code: "conflict" }],
    });
  });

  it("STRIPS an unknown field on a failed entry instead of rejecting the finalize", () => {
    // The version-skew case: a newer runtime adds `attempts` to each entry.
    const parsed = RunResultSchema.safeParse({
      ...BASE,
      artifacts: {
        status: "partial",
        published: 1,
        failed: [{ name: "lost.md", code: "upload_failed", attempts: 3, retry_after_ms: 250 }],
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.artifacts).toEqual({
      status: "partial",
      published: 1,
      failed: [{ name: "lost.md", code: "upload_failed" }],
    });
    expect(parsed.success && parsed.data.status).toBe("success");
  });

  it("STRIPS an unknown field at the summary root", () => {
    const parsed = RunResultSchema.safeParse({
      ...BASE,
      artifacts: { status: "complete", published: 3, failed: [], skipped: 7, sweep_ms: 12 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.artifacts).toEqual({
      status: "complete",
      published: 3,
      failed: [],
    });
  });

  it("degrades a structurally broken summary to absent, never a 400", () => {
    for (const artifacts of [
      { status: "weird", published: 1, failed: [] },
      { status: "complete", published: -1, failed: [] },
      { status: "complete", published: 1, failed: "not-an-array" },
      { status: "complete", published: 1, failed: [{ name: 42, code: null }] },
      "not-an-object",
      [],
    ]) {
      const parsed = RunResultSchema.safeParse({ ...BASE, artifacts });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.artifacts).toBeUndefined();
      expect(parsed.success && parsed.data.status).toBe("success");
    }
  });

  it("still clamps an oversized summary rather than dropping it", () => {
    const parsed = RunResultSchema.safeParse({
      ...BASE,
      artifacts: {
        status: "partial",
        published: 0,
        failed: Array.from({ length: 1500 }, (_, i) => ({
          name: "x".repeat(600) + `-${i}`,
          code: "y".repeat(100),
        })),
      },
    });
    expect(parsed.success).toBe(true);
    const artifacts = parsed.success ? parsed.data.artifacts : undefined;
    expect(artifacts?.failed).toHaveLength(1000);
    expect(artifacts?.failed[0]!.name).toHaveLength(512);
    expect(artifacts?.failed[0]!.code).toHaveLength(64);
  });

  it("keeps an absent summary absent", () => {
    const parsed = RunResultSchema.safeParse(BASE);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.artifacts).toBeUndefined();
  });
});
