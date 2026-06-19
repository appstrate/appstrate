// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 5 (model alias) — private usage ledger. `llm_usage.real_model` / `api`
 * retain the REAL backing id for billing + audit, but they are admin/cloud-only
 * and must never reach a user-facing surface. `listLlmUsageForRun` (the sole
 * service accessor, consumed by the cloud billing module) projects only
 * `id`/`costUsd`/`source` — this locks that projection so a future column add
 * can't silently leak the backing of a model alias.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { listLlmUsageForRun } from "../../../src/services/state/runs.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedRun } from "../../helpers/seed.ts";

describe("listLlmUsageForRun — private ledger never leaks the alias backing", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ledgerorg" });
  });

  it("returns only id/costUsd/source — never real_model / api / model", async () => {
    const run = await seedRun({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

    // A proxy row carrying the public alias in `model` and the hidden backing
    // in `real_model` — exactly the shape the sidecar/proxy writes for an alias.
    await db.insert(llmUsage).values({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      model: "appstrate-medium",
      realModel: "deepseek-chat-SECRET",
      api: "openai-completions",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0123,
      requestId: "req_alias_ledger_1",
    });

    const rows = await listLlmUsageForRun({
      runId: run.id,
      orgId: ctx.orgId,
      sources: ["proxy"],
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Exactly the public projection — no binding columns.
    expect(Object.keys(row).sort()).toEqual(["costUsd", "id", "source"]);
    expect(row.costUsd).toBeCloseTo(0.0123, 6);

    // Hard guarantee: neither the real backing nor the protocol family appears.
    const json = JSON.stringify(rows);
    expect(json).not.toContain("deepseek-chat-SECRET");
    expect(json).not.toContain("openai-completions");

    // Sanity: the row really is in the DB with the backing retained (private).
    const [raw] = await db
      .select({ realModel: llmUsage.realModel })
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, run.id), eq(llmUsage.orgId, ctx.orgId)));
    expect(raw!.realModel).toBe("deepseek-chat-SECRET");
  });
});
