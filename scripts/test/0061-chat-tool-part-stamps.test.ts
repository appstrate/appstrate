// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0061`: a tool part carrying `output.actedSpaceIds` has it moved into
 * `resultProviderMetadata.appstrate.actedSpaceIds`, and an unmarked trailing `[turn budget]` block
 * gets the marker; both are read back by the current readers. A dry run writes nothing, a second
 * run finds nothing, and every other part stays as it is.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import {
  formatTurnBudgetNote,
  isTurnBudgetNoteBlock,
  readAppstrateToolPartMetadata,
  turnBudgetNoteBlock,
} from "@appstrate/core/chat-turn-metadata";
import {
  pendingToolPartStamps,
  rewriteToolPartStamps,
  runChatToolPartStamps,
} from "../migration/0061-chat-tool-part-stamps.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";

const NOTE = formatTurnBudgetNote({ remainingMs: 252_000, stepsUsed: 3 });
const payload = { type: "text", text: JSON.stringify({ ok: true }) };

const tool = (output: unknown, extra: Record<string, unknown> = {}) => ({
  type: "tool-get_thing",
  toolCallId: `call_${crypto.randomUUID()}`,
  state: "output-available",
  input: {},
  output,
  ...extra,
});

type Part = {
  output: { content?: unknown[]; isError?: boolean; actedSpaceIds?: unknown } | unknown[];
  resultProviderMetadata?: unknown;
};

describe("rewriteToolPartStamps (0061)", () => {
  it("moves actedSpaceIds into the result metadata, keeping the other fields", () => {
    const old = tool(
      { content: [payload], isError: false, actedSpaceIds: ["spc_a", "spc_b"] },
      { resultProviderMetadata: { appstrate: { durationMs: 12 }, other: 1 } },
    );
    const { parts, acted, notes } = rewriteToolPartStamps([old]);
    const part = parts[0] as Part;
    expect([acted, notes]).toEqual([1, 0]);
    expect(part.output).toEqual({ content: [payload], isError: false });
    expect(readAppstrateToolPartMetadata(part.resultProviderMetadata)).toEqual({
      durationMs: 12,
      actedSpaceIds: ["spc_a", "spc_b"],
    });
    expect((part.resultProviderMetadata as { other: number }).other).toBe(1);
  });

  it("never overwrites an actedSpaceIds already in the metadata, and still clears the output", () => {
    const old = tool(
      { content: [payload], actedSpaceIds: ["spc_old"] },
      { resultProviderMetadata: { appstrate: { actedSpaceIds: ["spc_kept"] } } },
    );
    const part = rewriteToolPartStamps([old]).parts[0] as Part;
    expect(part.output).toEqual({ content: [payload] });
    expect(readAppstrateToolPartMetadata(part.resultProviderMetadata)?.actedSpaceIds).toEqual([
      "spc_kept",
    ]);
  });

  it("keeps an empty list (organization-wide) and handles a dynamic tool", () => {
    const old = { ...tool({ content: [payload], actedSpaceIds: [] }), type: "dynamic-tool" };
    const part = rewriteToolPartStamps([old]).parts[0] as Part;
    expect(readAppstrateToolPartMetadata(part.resultProviderMetadata)?.actedSpaceIds).toEqual([]);
  });

  it("drops a malformed actedSpaceIds from the output without stamping it", () => {
    const old = tool({ content: [payload], actedSpaceIds: [1, 2] });
    const part = rewriteToolPartStamps([old]).parts[0] as Part;
    expect(part.output).toEqual({ content: [payload] });
    expect(part.resultProviderMetadata).toBeUndefined();
  });

  it("marks the trailing budget note exactly as turnBudgetNoteBlock builds it", () => {
    const old = tool({ content: [payload, { type: "text", text: NOTE }] });
    const { parts, notes } = rewriteToolPartStamps([old]);
    const blocks = (parts[0] as Part & { output: { content: unknown[] } }).output.content;
    expect(notes).toBe(1);
    expect(blocks[0]).toEqual(payload);
    expect(blocks[1]).toEqual(turnBudgetNoteBlock(NOTE));
    expect(isTurnBudgetNoteBlock(blocks[1])).toBe(true);
  });

  it("marks the note of a bare content array too", () => {
    const { parts, notes } = rewriteToolPartStamps([tool([payload, { type: "text", text: NOTE }])]);
    expect(notes).toBe(1);
    expect(isTurnBudgetNoteBlock((parts[0] as { output: unknown[] }).output[1])).toBe(true);
  });

  it("leaves a marked note, a non-trailing look-alike, other tools and plain parts untouched", () => {
    const kept = [
      tool({ content: [payload, turnBudgetNoteBlock(NOTE)] }),
      tool({ content: [{ type: "text", text: NOTE }, payload] }),
      tool({ content: [{ type: "text", text: "[turn budget]no space" }] }),
      tool({ content: [payload] }, { resultProviderMetadata: { appstrate: { durationMs: 1 } } }),
      { type: "tool-pending", toolCallId: "c", state: "input-available", input: {} },
      { type: "text", text: NOTE },
    ];
    const { parts, acted, notes } = rewriteToolPartStamps(kept);
    expect([acted, notes]).toEqual([0, 0]);
    expect(parts).toEqual(kept);
  });
});

describe("0061 — chat tool part stamps rewritten", () => {
  let ctx: TestContext;
  const lines: string[] = [];
  const run = (apply: boolean) => runChatToolPartStamps({ apply, out: (line) => lines.push(line) });

  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0061" });
  });

  it("writes nothing on a dry run, rewrites once on --apply, then finds nothing", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const untouched = tool({ content: [payload] });
    const old = tool({
      content: [payload, { type: "text", text: NOTE }],
      actedSpaceIds: ["spc_a"],
    });
    const [row] = await db
      .insert(chatMessages)
      .values({
        sessionId,
        messageId: "m1",
        content: { role: "assistant", parts: [{ type: "text", text: "hi" }, untouched, old] },
      })
      .returning({ seq: chatMessages.seq });
    await db.insert(chatMessages).values({
      sessionId,
      messageId: "m2",
      content: { role: "user", parts: [{ type: "text", text: "mentions actedSpaceIds" }] },
    });
    const stored = async () =>
      (await db.select().from(chatMessages).where(eq(chatMessages.seq, row!.seq)))[0]!.content;
    const before = JSON.stringify(await stored());

    expect(await pendingToolPartStamps()).toEqual({ scanned: 2, parts: 1, blocks: 1, rows: 1 });
    await run(false);
    expect(lines).toContain(
      "messages scanned: 2, parts rewritten (actedSpaceIds): 1, blocks marked (turn budget): 1, rows changed: 1",
    );
    expect(JSON.stringify(await stored())).toBe(before);

    await run(true);
    expect(lines).toContain("0061: APPLIED — committed.");
    const parts = (await stored()).parts as Part[];
    expect(parts[1]).toEqual(untouched as unknown as Part);
    expect(parts[2]!.output).toEqual({
      content: [payload, turnBudgetNoteBlock(NOTE)],
    });
    expect(readAppstrateToolPartMetadata(parts[2]!.resultProviderMetadata)?.actedSpaceIds).toEqual([
      "spc_a",
    ]);

    const after = JSON.stringify(await stored());
    expect((await pendingToolPartStamps()).rows).toBe(0);
    lines.length = 0;
    await run(true);
    expect(lines).toContain("left: 0");
    expect(JSON.stringify(await stored())).toBe(after);
  });
});
