// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0055`: a file read persisted before #2280 (the file's text, or its bytes as a base64
 * resource) becomes the receipt the chat persists now; a receipt, platform metadata, a skill read
 * and every other tool stay as they are; a dry run writes nothing and a second run finds nothing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import {
  rewriteFileReads,
  runChatFileReadReceipts,
} from "../migration/0055-chat-file-read-receipts.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";

const URI = "appfile://file_contract1";
const BLOB = "JVBERi0xLjQKJ-BASE64-MUST-GO";

const read = (toolName: string, uri: string, texts: string[]) => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: `call_${crypto.randomUUID()}`,
  state: "output-available",
  input: { uri },
  output: { content: texts.map((text) => ({ type: "text", text })) },
});

const receiptText = (part: unknown) =>
  JSON.parse(
    ((part as { output: { content: { text: string }[] } }).output.content[0] as { text: string })
      .text,
  ) as Record<string, unknown>;

describe("rewriteFileReads (0055)", () => {
  it("turns a base64 resource into a receipt naming the uri, type and size, without the bytes", () => {
    const old = read("read_file", URI, [
      JSON.stringify({
        type: "resource",
        resource: { uri: URI, mimeType: "application/pdf", blob: BLOB },
      }),
    ]);
    const { parts, rewritten } = rewriteFileReads([old]);
    expect(rewritten).toBe(1);
    expect(JSON.stringify(parts)).not.toContain(BLOB);
    expect(receiptText(parts[0])).toMatchObject({
      uri: URI,
      mimeType: "application/pdf",
      size: Buffer.byteLength(BLOB, "base64"),
    });
  });

  it("drops a file's text read verbatim, a JSON document included", () => {
    const old = read("read_resource", URI, [JSON.stringify({ clause: "Confidential" })]);
    const { parts, rewritten } = rewriteFileReads([old]);
    expect(rewritten).toBe(1);
    expect(JSON.stringify(parts)).not.toContain("Confidential");
  });

  it("keeps a receipt, platform metadata, a skill read and any other tool as they are", () => {
    const kept = [
      read("read_file", URI, [
        JSON.stringify({
          uri: URI,
          mimeType: "image/png",
          size: 3,
          note: "File read for this turn.",
        }),
      ]),
      read("read_file", URI, [
        JSON.stringify({
          id: "file_contract1",
          uri: URI,
          downloadable: false,
          note: "Content is not downloadable by you",
        }),
      ]),
      read("read_resource", "skill://spc_1/acme/tone/SKILL.md", ["Write concisely"]),
      read("call_integration_tool", URI, ["upstream body"]),
      { type: "text", text: "plain" },
    ];
    const { parts, rewritten } = rewriteFileReads(kept);
    expect(rewritten).toBe(0);
    expect(parts).toEqual(kept);
  });
});

describe("0055 — chat file reads rewritten as receipts", () => {
  let ctx: TestContext;
  const lines: string[] = [];
  const run = (apply: boolean) =>
    runChatFileReadReceipts({ apply, out: (line) => lines.push(line) });

  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0055" });
  });

  it("writes nothing on a dry run, rewrites once on --apply, then finds nothing", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const old = read("read_file", URI, [
      JSON.stringify({
        type: "resource",
        resource: { uri: URI, mimeType: "application/pdf", blob: BLOB },
      }),
    ]);
    const [row] = await db
      .insert(chatMessages)
      .values({ sessionId, messageId: "m1", content: { role: "assistant", parts: [old] } })
      .returning({ seq: chatMessages.seq });
    const stored = async () =>
      JSON.stringify(
        (await db.select().from(chatMessages).where(eq(chatMessages.seq, row!.seq)))[0]!.content,
      );

    await run(false);
    expect(lines).toContain("messages to rewrite: 1, file reads: 1");
    expect(await stored()).toContain(BLOB);

    await run(true);
    expect(lines).toContain("0055: APPLIED — committed.");
    expect(await stored()).not.toContain(BLOB);
    expect(await stored()).toContain(URI);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("messages to rewrite: 0, file reads: 0");
  });
});
