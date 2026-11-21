// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/:orgId/chat/sessions/:id` serves `usage`: the ledger rows metered for the
 * conversation, summed, in the `TokenUsage` shape. Another conversation's rows are not in it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";

const app = getTestApp();

function orgCall(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/orgs/${ctx.orgId}/chat${path}`, {
    ...init,
    headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
  });
}

async function createSession(ctx: TestContext): Promise<string> {
  const res = await orgCall(ctx, "/sessions", { method: "POST", body: "{}" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

let seq = 0;
async function meter(
  ctx: TestContext,
  chatSessionId: string,
  tokens: { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null },
): Promise<void> {
  seq += 1;
  await db.insert(llmUsage).values({
    source: "proxy",
    orgId: ctx.orgId,
    chatSessionId,
    model: "preset_test",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead ?? null,
    cacheWriteTokens: tokens.cacheWrite ?? null,
    pricingStatus: "priced",
    requestId: `req_usage_${seq}`,
  });
}

describe("chat session usage", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgusage" });
  });

  it("reads zero for a conversation no turn was metered for", async () => {
    const id = await createSession(ctx);
    const body = (await (await orgCall(ctx, `/sessions/${id}`)).json()) as { usage: unknown };
    expect(body.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("sums the rows metered for the conversation, and only those", async () => {
    const id = await createSession(ctx);
    const other = await createSession(ctx);
    await meter(ctx, id, { input: 1_000, output: 200, cacheRead: 18_000, cacheWrite: 500 });
    // A row a provider reported no cache for counts as zero, not as a hole in the sum.
    await meter(ctx, id, { input: 1_500, output: 300, cacheRead: null, cacheWrite: null });
    await meter(ctx, other, { input: 9_999, output: 9_999 });

    const res = await orgCall(ctx, `/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { usage: unknown }).usage).toEqual({
      input_tokens: 2_500,
      output_tokens: 500,
      cache_read_input_tokens: 18_000,
      cache_creation_input_tokens: 500,
    });
  });
});
