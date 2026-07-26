// SPDX-License-Identifier: Apache-2.0

/**
 * B5/D4 — where the full payload lives when a tool result truncates it.
 *
 * `@appstrate/core`'s run_and_wait client decides the truncation, but it is
 * published on npm and carries no DB or storage dependency: it can only be
 * handed a `document://` URI. Finalize is what produces one — a run whose
 * structured `result` overruns `RUN_RESULT_INLINE_MAX_BYTES` gets that result
 * written as a durable `agent_output` document under the reserved name, anchored
 * to the run (the correct container: an `agent_output` is readable by exactly
 * whoever can read the run, i.e. whoever sees the truncated tool result).
 *
 * Asserted here: the spill fires only above the threshold, stores the COMPLETE
 * payload, and never turns a completed run's finalize into a failure.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, documents } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import {
  RUN_RESULT_INLINE_MAX_BYTES,
  RUN_RESULT_SPILL_DOCUMENT_NAME,
} from "@appstrate/core/run-and-wait-client";
import { downloadStream } from "@appstrate/db/storage";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { parseStorageKey } from "../../../src/services/documents.ts";

const app = getTestApp();
const RUN_SECRET = "a".repeat(43);

function signedHeaders(body: string): Record<string, string> {
  const headers = sign({
    msgId: `msg_${crypto.randomUUID()}`,
    timestampSec: Math.floor(Date.now() / 1000),
    body,
    secret: RUN_SECRET,
  });
  return { "Content-Type": "application/json", ...headers };
}

/** A `{ text }` output whose serialization under `{ output: … }` exceeds `bytes`. */
function outputOfAtLeast(bytes: number): { text: string } {
  return { text: "x".repeat(bytes) };
}

describe("finalize — oversized run result spills to a document", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "spill@test.dev", orgSlug: "spill-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/spill-agent", type: "agent" });
  });

  async function seedRunWithSink(): Promise<string> {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id: runId,
      packageId: "@test/spill-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      runOrigin: "platform",
      sinkSecretEncrypted: encrypt(RUN_SECRET),
      sinkExpiresAt: new Date(Date.now() + 3600_000),
      startedAt: new Date(),
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    return runId;
  }

  async function finalize(runId: string, output: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify({
      memories: [],
      logs: [],
      status: "success",
      output,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    return app.request(`/api/runs/${runId}/events/finalize`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
  }

  async function spillDocuments(runId: string) {
    return db
      .select({
        id: documents.id,
        name: documents.name,
        mime: documents.mime,
        size: documents.size,
        storageKey: documents.storageKey,
        purpose: documents.purpose,
      })
      .from(documents)
      .where(and(eq(documents.runId, runId), eq(documents.name, RUN_RESULT_SPILL_DOCUMENT_NAME)));
  }

  it("writes the COMPLETE result under the reserved name when it overruns the cap", async () => {
    const runId = await seedRunWithSink();
    const output = outputOfAtLeast(RUN_RESULT_INLINE_MAX_BYTES + 1_000);

    expect((await finalize(runId, output)).status).toBe(200);

    // The run row still carries its own result — the spill is an ADDITION, the
    // truncation happens only in the tool result the model reads.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect((row?.result as { output?: unknown } | null)?.output).toEqual(output);

    const [doc] = await spillDocuments(runId);
    expect(doc).toBeDefined();
    expect(doc!.purpose).toBe("agent_output");
    expect(doc!.mime).toBe("application/json");

    // The stored bytes are the whole payload, byte-for-byte.
    const parsed = parseStorageKey(doc!.storageKey)!;
    const stored = await new Response(
      await downloadStream(parsed.bucket, parsed.path),
    ).arrayBuffer();
    expect(JSON.parse(new TextDecoder().decode(stored))).toEqual({ output });
    expect(doc!.size).toBe(stored.byteLength);
  });

  it("writes nothing for a result that fits inline", async () => {
    const runId = await seedRunWithSink();
    expect((await finalize(runId, { answer: 42 })).status).toBe(200);

    expect(await spillDocuments(runId)).toHaveLength(0);
    const all = await db.select().from(documents).where(eq(documents.runId, runId));
    expect(all).toHaveLength(0);
  });

  it("stays idempotent across a replayed finalize (dedup, not a second copy)", async () => {
    const runId = await seedRunWithSink();
    const output = outputOfAtLeast(RUN_RESULT_INLINE_MAX_BYTES + 1_000);

    expect((await finalize(runId, output)).status).toBe(200);
    // A replay hits the CAS no-op; either way there must be exactly one document.
    await finalize(runId, output);

    expect(await spillDocuments(runId)).toHaveLength(1);
  });
});
