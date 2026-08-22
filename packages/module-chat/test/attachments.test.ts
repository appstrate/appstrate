// SPDX-License-Identifier: Apache-2.0

/**
 * Chat file attachments (Phase 1) — the composer→file pipeline.
 *
 * Covers the module-side lifecycle end to end against the real platform:
 *  - an `upload://` file part materializes into a chat-session-scoped file
 *    and the part is rewritten to the stable `appfile://` URI, both in memory
 *    and once persisted into `chat_messages.content`;
 *  - a historical `document://` URI still resolves to its file (#1177);
 *  - an `appfile://` belonging to another user is rejected (container ACL);
 *  - file parts flatten to the model-facing `[Attached file: …]` block in
 *    both the transcript builder and the shared serializer;
 *  - a quota rejection surfaces as the platform's RFC 9457 error, not a crash.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { files, uploads, chatSessions, chatMessages } from "@appstrate/db/schema";
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
import { resolveChatAttachment } from "../../../apps/api/src/services/files.ts";
import { materializeUserAttachments, messagesWithAttachmentsAsText } from "../src/attachments.ts";
import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";
import { buildStructuredPiTurn } from "../src/pi-chat/structured-session.ts";
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
      { type: "text", text: "Résume ce file" },
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

  it("materializes an upload:// part into a session-scoped file and rewrites it to appfile://", async () => {
    const bytes = new TextEncoder().encode("a real pdf-ish payload");
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "rapport.txt", bytes);

    const message = fileMessage("m1", `upload://${uploadId}`, "rapport.txt");
    const rewritten = await materializeUserAttachments(
      message,
      resolverFor(scope, ctx.user.id, sessionId),
    );

    // The in-memory part is rewritten to appfile:// + carries the size.
    const filePart = rewritten.parts.find((p) => p.type === "file") as {
      url: string;
      providerMetadata?: { appstrate?: { size?: number } };
    };
    expect(filePart.url.startsWith("appfile://")).toBe(true);
    expect(filePart.providerMetadata?.appstrate?.size).toBe(bytes.byteLength);

    // A durable file row exists, anchored to the chat session, attributed
    // to its owner, purpose user_upload.
    const fileId = filePart.url.slice("appfile://".length);
    const [file] = await db.select().from(files).where(eq(files.id, fileId));
    expect(file).toBeDefined();
    expect(file!.chatSessionId).toBe(sessionId);
    expect(file!.runId).toBeNull();
    expect(file!.userId).toBe(ctx.user.id);
    expect(file!.purpose).toBe("user_upload");
    expect(file!.size).toBe(bytes.byteLength);

    // Persisted chat message stores ONLY the appfile:// URI (never upload://).
    await persistUserMessage(sessionId, rewritten);
    const [stored] = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.messageId, "m1")));
    const storedPart = (stored!.content as { parts: { type: string; url?: string }[] }).parts.find(
      (p) => p.type === "file",
    );
    expect(storedPart!.url).toBe(`appfile://${fileId}`);
  });

  it("still resolves a historical document:// URI to the same file", async () => {
    // Chat messages persisted before #1177 carry the old scheme. The resolver
    // must accept it — core's `parseFileUri` reads both — or every attachment
    // in an older conversation becomes unresolvable on reload.
    const bytes = new TextEncoder().encode("legacy-scheme payload");
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "vieux.txt", bytes);
    const resolve = resolverFor(scope, ctx.user.id, sessionId);

    const canonical = (
      (
        await materializeUserAttachments(
          fileMessage("m1", `upload://${uploadId}`, "vieux.txt"),
          resolve,
        )
      ).parts.find((p) => p.type === "file") as { url: string }
    ).url;
    const fileId = canonical.slice("appfile://".length);

    const legacy = await resolve(`document://${fileId}`);
    expect(legacy.uri).toBe(canonical);
    expect(legacy.name).toBe("vieux.txt");
    expect(legacy.size).toBe(bytes.byteLength);
  });

  it("rejects an appfile:// belonging to another user (container ACL)", async () => {
    // User A materializes a file in A's own chat session.
    const bytes = new TextEncoder().encode("owner-only file");
    const sessionA = await createSession(ctx.orgId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "a.pdf", bytes);
    const [ownFile] = (
      await materializeUserAttachments(
        fileMessage("mA", `upload://${uploadId}`, "a.pdf"),
        resolverFor(scope, ctx.user.id, sessionA),
      )
    ).parts.filter((p) => p.type === "file") as { url: string }[];

    // User B (same org, different user) cannot resolve A's file.
    const userB = await createTestUser();
    await addOrgMember(ctx.orgId, userB.id, "member");
    const sessionB = await createSession(ctx.orgId, userB.id);

    await expect(resolverFor(scope, userB.id, sessionB)(ownFile!.url)).rejects.toMatchObject({
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
    const fileId = (rewritten.parts.find((p) => p.type === "file") as { url: string }).url;

    // Shared serializer: file part → a single text part with the block.
    const [asText] = messagesWithAttachmentsAsText([rewritten]);
    const textParts = asText!.parts.filter((p) => p.type === "text") as { text: string }[];
    const block = textParts.map((p) => p.text).join("\n");
    expect(block).toContain(`[Attached file: rapport.txt — ${fileId} — text/plain`);
    expect(block).toContain("2.3 MB");
    expect(asText!.parts.some((p) => p.type === "file")).toBe(false);

    // Pi structured projection surfaces the same block in the current prompt.
    const { estimateTokens } = await loadPiCodingAgentSdk();
    const turn = buildStructuredPiTurn(
      [rewritten],
      { api: "openai-completions", provider: "openai", model: "attachment-test" },
      { estimateTokens, baseTokens: 0 },
    );
    expect(turn.prompt).toContain(fileId);
    expect(turn.prompt).toContain("[Attached file: rapport.txt");
  });

  it("rejects an attachment URI that is neither upload:// nor appfile:// (e.g. https://)", async () => {
    // The composer seam only resolves staged uploads or existing files — a
    // remote URL must be refused, never fetched (SSRF / exfil vector).
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    await expect(
      resolverFor(scope, ctx.user.id, sessionId)("https://evil.example.com/secret.txt"),
    ).rejects.toMatchObject({ status: 400 });
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

    // No file row survives the rejected materialization.
    const rows = await db.select().from(files).where(eq(files.chatSessionId, sessionId));
    expect(rows.length).toBe(0);
  });
});
