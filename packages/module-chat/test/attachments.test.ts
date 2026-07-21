// SPDX-License-Identifier: Apache-2.0

/**
 * Chat file attachments (Phase 1) — the composer→document pipeline.
 *
 * Covers the module-side lifecycle end to end against the real platform:
 *  - an `upload://` file part materializes into a chat-session-scoped document
 *    and the part is rewritten to the stable `document://` URI, both in memory
 *    and once persisted into `chat_messages.content`;
 *  - a `document://` belonging to another user is rejected (container ACL);
 *  - file parts flatten to the model-facing `[Attached document: …]` block in
 *    both the transcript builder and the shared serializer;
 *  - a quota rejection surfaces as the platform's RFC 9457 error, not a crash.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { documents, uploads, chatSessions, chatMessages } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { _resetCacheForTesting } from "@appstrate/env";
import type { UIMessage } from "ai";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { createUpload } from "../../../apps/api/src/services/uploads.ts";
import { resolveChatAttachment } from "../../../apps/api/src/services/documents.ts";
import { materializeUserAttachments, messagesWithAttachmentsAsText } from "../src/attachments.ts";
import { buildTranscriptPrompt } from "../src/transcript.ts";
import { persistUserMessage } from "../src/persistence.ts";

// Boot the platform app once (registers routes, storage, DB) — this test drives
// the services directly, so the handle itself is not referenced.
getTestApp();

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: { orgId: string; applicationId: string },
  createdBy: string,
  name: string,
  bytes: Uint8Array,
  mime = "text/plain",
): Promise<string> {
  const up = await createUpload({
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    createdBy,
    name,
    size: bytes.byteLength,
    mime,
  });
  const [row] = await db
    .select({ storageKey: uploads.storageKey })
    .from(uploads)
    .where(eq(uploads.id, up.id));
  const [bucket, ...rest] = row!.storageKey.split("/");
  await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
  return up.id;
}

/** A chat session row owned by `userId`. */
async function createSession(orgId: string, userId: string): Promise<string> {
  const id = `chs_${crypto.randomUUID()}`;
  await db.insert(chatSessions).values({ id, orgId, userId, title: null });
  return id;
}

/** A one-part user UIMessage carrying a file attachment URI. */
function fileMessage(id: string, uri: string, name: string, mime = "text/plain"): UIMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "Résume ce document" },
      { type: "file", url: uri, mediaType: mime, filename: name },
    ],
  } as UIMessage;
}

/** Bind the platform seam to a (user, session) — mirrors the chat-stream call. */
function resolverFor(
  scope: { orgId: string; applicationId: string },
  userId: string,
  sessionId: string,
) {
  return (uri: string) =>
    resolveChatAttachment({
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      userId,
      chatSessionId: sessionId,
      uri,
    });
}

describe("chat attachments", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };

  beforeEach(async () => {
    await truncateAll();
    _resetCacheForTesting();
    ctx = await createTestContext({ orgSlug: "chatattach" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
  });

  it("materializes an upload:// part into a session-scoped document and rewrites it to document://", async () => {
    const bytes = new TextEncoder().encode("a real pdf-ish payload");
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "rapport.txt", bytes);

    const message = fileMessage("m1", `upload://${uploadId}`, "rapport.txt");
    const rewritten = await materializeUserAttachments(
      message,
      resolverFor(scope, ctx.user.id, sessionId),
    );

    // The in-memory part is rewritten to document:// + carries the size.
    const filePart = rewritten.parts.find((p) => p.type === "file") as {
      url: string;
      providerMetadata?: { appstrate?: { size?: number } };
    };
    expect(filePart.url.startsWith("document://")).toBe(true);
    expect(filePart.providerMetadata?.appstrate?.size).toBe(bytes.byteLength);

    // A durable document row exists, anchored to the chat session, attributed
    // to its owner, purpose user_upload.
    const docId = filePart.url.slice("document://".length);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(doc).toBeDefined();
    expect(doc!.chatSessionId).toBe(sessionId);
    expect(doc!.runId).toBeNull();
    expect(doc!.userId).toBe(ctx.user.id);
    expect(doc!.purpose).toBe("user_upload");
    expect(doc!.size).toBe(bytes.byteLength);

    // Persisted chat message stores ONLY the document:// URI (never upload://).
    await persistUserMessage(sessionId, rewritten);
    const [stored] = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.messageId, "m1")));
    const storedPart = (stored!.content as { parts: { type: string; url?: string }[] }).parts.find(
      (p) => p.type === "file",
    );
    expect(storedPart!.url).toBe(`document://${docId}`);
  });

  it("rejects a document:// belonging to another user (container ACL)", async () => {
    // User A materializes a document in A's own chat session.
    const bytes = new TextEncoder().encode("owner-only doc");
    const sessionA = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "a.pdf", bytes);
    const [ownDoc] = (
      await materializeUserAttachments(
        fileMessage("mA", `upload://${uploadId}`, "a.pdf"),
        resolverFor(scope, ctx.user.id, sessionA),
      )
    ).parts.filter((p) => p.type === "file") as { url: string }[];

    // User B (same org, different user) cannot resolve A's document.
    const userB = await createTestUser();
    await addOrgMember(ctx.orgId, userB.id, "member");
    const sessionB = await createSession(ctx.orgId, userB.id);

    await expect(resolverFor(scope, userB.id, sessionB)(ownDoc!.url)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("flattens file parts into the model-facing attachment block (both paths)", async () => {
    const bytes = new TextEncoder().encode("x".repeat(2_400_000));
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "rapport.txt", bytes);
    const rewritten = await materializeUserAttachments(
      fileMessage("m1", `upload://${uploadId}`, "rapport.txt"),
      resolverFor(scope, ctx.user.id, sessionId),
    );
    const docId = (rewritten.parts.find((p) => p.type === "file") as { url: string }).url;

    // Shared serializer: file part → a single text part with the block.
    const [asText] = messagesWithAttachmentsAsText([rewritten]);
    const textParts = asText!.parts.filter((p) => p.type === "text") as { text: string }[];
    const block = textParts.map((p) => p.text).join("\n");
    expect(block).toContain(`[Attached document: rapport.txt — ${docId} — text/plain`);
    expect(block).toContain("2.3 MB");
    expect(asText!.parts.some((p) => p.type === "file")).toBe(false);

    // Pi transcript path surfaces the same block to the model.
    const transcript = buildTranscriptPrompt([rewritten]);
    expect(transcript).toContain(docId);
    expect(transcript).toContain("[Attached document: rapport.txt");
  });

  it("surfaces a storage-quota rejection as an RFC 9457 error", async () => {
    const bytes = new TextEncoder().encode("over quota");
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "big.pdf", bytes);

    const prev = process.env.ORG_STORAGE_QUOTA_BYTES;
    process.env.ORG_STORAGE_QUOTA_BYTES = "1";
    _resetCacheForTesting();
    try {
      await expect(
        materializeUserAttachments(
          fileMessage("m1", `upload://${uploadId}`, "big.pdf"),
          resolverFor(scope, ctx.user.id, sessionId),
        ),
      ).rejects.toMatchObject({ status: 403, code: "storage_limit_exceeded" });
    } finally {
      if (prev === undefined) delete process.env.ORG_STORAGE_QUOTA_BYTES;
      else process.env.ORG_STORAGE_QUOTA_BYTES = prev;
      _resetCacheForTesting();
    }

    // No document row survives the rejected materialization.
    const rows = await db.select().from(documents).where(eq(documents.chatSessionId, sessionId));
    expect(rows.length).toBe(0);
  });
});
