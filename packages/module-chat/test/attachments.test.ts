// SPDX-License-Identifier: Apache-2.0

/**
 * Chat file attachments (Phase 1) — the composer→file pipeline.
 *
 * Covers the module-side lifecycle end to end against the real platform:
 *  - an `upload://` file part materializes into a chat-session-scoped file
 *    and the part is rewritten to the stable `appfile://` URI, both in memory
 *    and once persisted into `chat_messages.content`;
 *  - the retired `document://` URI scheme is refused (#1177);
 *  - an `appfile://` belonging to another user is rejected (container ACL);
 *  - file parts flatten to the model-facing `[Attached file: …]` block in
 *    both the transcript builder and the shared serializer;
 *  - a quota rejection surfaces as the platform's RFC 9457 error, not a crash.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { auditEvents, files, uploads, chatSessions, chatMessages } from "@appstrate/db/schema";
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
import {
  createChatFileFromBytes,
  readChatImage,
  resolveChatAttachment,
} from "../../../apps/api/src/services/files.ts";
import { materializeUserAttachments, messagesWithAttachmentsAsText } from "../src/attachments.ts";
import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";
import { buildStructuredPiTurn } from "../src/pi-chat/structured-session.ts";
import { persistUserMessage } from "../src/persistence.ts";

// Boot the platform app once (registers routes, storage, DB) — this test drives
// the services directly, so the handle itself is not referenced.
getTestApp();

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: { orgId: string; spaceId: string },
  createdBy: string,
  name: string,
  bytes: Uint8Array,
  mime = "text/plain",
): Promise<string> {
  const up = await createUpload({
    orgId: scope.orgId,
    spaceId: scope.spaceId,
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
async function createSession(orgId: string, spaceId: string, userId: string): Promise<string> {
  const id = `chs_${crypto.randomUUID()}`;
  await db.insert(chatSessions).values({ id, orgId, spaceId, userId, title: null });
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
function resolverFor(scope: { orgId: string; spaceId: string }, userId: string, sessionId: string) {
  return (uri: string) =>
    resolveChatAttachment({
      orgId: scope.orgId,
      userId,
      chatSessionId: sessionId,
      uri,
      // These cases materialize the session owner's own uploads; the container
      // ACL never widens, so the narrowest set is the honest one to hand it.
      spaces: [{ id: scope.spaceId, permissions: new Set() }],
      beforeResolve: async () => {},
    });
}

describe("chat attachments", () => {
  let ctx: TestContext;
  let scope: { orgId: string; spaceId: string };

  beforeEach(async () => {
    await truncateAll();
    _resetCacheForTesting();
    ctx = await createTestContext({ orgSlug: "chatattach" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
  });

  it("materializes an upload:// part into a session-scoped file and rewrites it to appfile://", async () => {
    const bytes = new TextEncoder().encode("a real pdf-ish payload");
    const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
    const uploadId = await stageUpload(scope, ctx.user.id, "rapport.txt", bytes);

    const message = fileMessage("m1", `upload://${uploadId}`, "rapport.txt");
    const rewritten = await materializeUserAttachments(
      message,
      resolverFor(scope, ctx.user.id, sessionId),
    );

    // The in-memory part is rewritten to appfile:// + carries the size.
    const filePart = rewritten.parts.find((p) => p.type === "file") as {
      url: string;
      providerMetadata?: { appstrate?: { size?: number; spaceId?: string } };
    };
    expect(filePart.url.startsWith("appfile://")).toBe(true);
    expect(filePart.providerMetadata?.appstrate?.size).toBe(bytes.byteLength);
    // The space it lives in travels with it: a download after the working space changes reads there.
    expect(filePart.providerMetadata?.appstrate?.spaceId).toBe(ctx.defaultSpaceId);

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

  it("refuses the retired document:// scheme", async () => {
    // Kept resolvable until the id prefix moved to `file_`. Every URI ever
    // written under the old scheme addresses a `doc_` id, which `parseFileUri`
    // rejects, so the prefix could only still have matched `document://file_…`
    // — a pairing no build ever emitted. Both halves are refused now, and the
    // one that used to get through failed one line later anyway.
    const bytes = new TextEncoder().encode("legacy-scheme payload");
    const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
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

    await expect(resolve(`document://${fileId}`)).rejects.toThrow(/upload:\/\/' or 'appfile:\/\//);
    await expect(resolve("document://doc_aaaaaaaa")).rejects.toThrow(
      /upload:\/\/' or 'appfile:\/\//,
    );
  });

  it("rejects an appfile:// belonging to another user (container ACL)", async () => {
    // User A materializes a file in A's own chat session.
    const bytes = new TextEncoder().encode("owner-only file");
    const sessionA = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
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
    const sessionB = await createSession(ctx.orgId, ctx.defaultSpaceId, userB.id);

    await expect(resolverFor(scope, userB.id, sessionB)(ownFile!.url)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("flattens file parts into the model-facing attachment block (both paths)", async () => {
    const bytes = new TextEncoder().encode("x".repeat(2_400_000));
    const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
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
    const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
    await expect(
      resolverFor(scope, ctx.user.id, sessionId)("https://evil.example.com/secret.txt"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("surfaces a storage-quota rejection as an RFC 9457 error", async () => {
    const bytes = new TextEncoder().encode("over quota");
    const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
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
  describe("readChatImage (the pixels of an attachment, for a vision model)", () => {
    const PNG = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    /** Materialize `bytes` as an attachment of a fresh session and return its appfile:// URI. */
    async function attach(name: string, bytes: Uint8Array, mime: string): Promise<string> {
      const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
      const uploadId = await stageUpload(scope, ctx.user.id, name, bytes, mime);
      const resolved = await resolverFor(scope, ctx.user.id, sessionId)(`upload://${uploadId}`);
      return resolved.uri;
    }

    const request = (
      uri: string,
      over: { userId?: string; maxBytes?: number; permissions?: string[] } = {},
    ) => ({
      orgId: ctx.orgId,
      userId: over.userId ?? ctx.user.id,
      uri,
      spaces: [
        { id: ctx.defaultSpaceId, permissions: new Set(over.permissions ?? ["files:read"]) },
      ],
      maxBytes: over.maxBytes ?? 4096,
    });

    it("returns the base64 bytes and the normalized mime of an image the owner attached", async () => {
      const uri = await attach("chart.png", PNG, "image/png");
      const image = await readChatImage(request(uri));
      expect(image).toEqual({
        mime: "image/png",
        data: Buffer.from(PNG).toString("base64"),
        size: PNG.byteLength,
      });
    });

    it("is null for a file that is not an image a provider accepts", async () => {
      const text = await attach("note.txt", new TextEncoder().encode("hi"), "text/plain");
      const svg = await attach("logo.svg", new TextEncoder().encode("<svg/>"), "image/svg+xml");
      expect(await readChatImage(request(text))).toBeNull();
      expect(await readChatImage(request(svg))).toBeNull();
    });

    it("is null past the caller's byte cap", async () => {
      const uri = await attach("chart.png", PNG, "image/png");
      expect(await readChatImage(request(uri, { maxBytes: PNG.byteLength - 1 }))).toBeNull();
    });

    it("is null for another user's file (container ACL) and for a space the caller cannot reach", async () => {
      const uri = await attach("chart.png", PNG, "image/png");
      const other = await createTestUser();
      await addOrgMember(ctx.orgId, other.id, "member");
      expect(await readChatImage(request(uri, { userId: other.id }))).toBeNull();
      expect(await readChatImage({ ...request(uri), spaces: [] })).toBeNull();
    });

    it("is null once `files:read` is withdrawn, re-asked at every read (between two turns)", async () => {
      const uri = await attach("chart.png", PNG, "image/png");
      expect(await readChatImage(request(uri))).not.toBeNull();
      // Same owner, same file, same space: only the grant changed since the attach.
      expect(await readChatImage(request(uri, { permissions: ["chat:write"] }))).toBeNull();
    });

    it("is null for a malformed or non-appfile URI", async () => {
      expect(await readChatImage(request("upload://upl_x"))).toBeNull();
      expect(await readChatImage(request("https://evil.example.com/a.png"))).toBeNull();
      expect(await readChatImage(request("appfile://not-a-file"))).toBeNull();
    });
  });
  describe("createChatFileFromBytes (a connector import stored in the conversation)", () => {
    const PNG = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const actor = () => ({ type: "user" as const, id: ctx.user.id });
    const SOURCE = {
      kind: "integration_import" as const,
      integrationId: "@appstrate/google-drive",
      proxyRequestId: "req_proxy_1",
    };

    it("anchors the file to the conversation, owner-readable, with the sniffed MIME", async () => {
      const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
      const row = await createChatFileFromBytes(scope, actor(), sessionId, {
        name: "drive-image",
        // Drive serves `application/octet-stream`: the bytes say it is a PNG.
        mime: "application/octet-stream",
        bytes: PNG,
        source: SOURCE,
      });
      expect(row).toMatchObject({
        chatSessionId: sessionId,
        runId: null,
        purpose: "user_upload",
        mime: "image/png",
        size: PNG.byteLength,
      });
      // The same ACL as an upload: the owner reads it back as an attachment (and a vision model sees it).
      const image = await readChatImage({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        uri: `appfile://${row.id}`,
        spaces: [{ id: ctx.defaultSpaceId, permissions: new Set(["files:read"]) }],
        maxBytes: 4096,
      });
      expect(image?.mime).toBe("image/png");
      // The audit tells the import from an upload: the integration and the proxy call it came from.
      const [created] = await db
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "file.created"), eq(auditEvents.resourceId, row.id)));
      expect(created?.after).toMatchObject({ purpose: "user_upload", source: SOURCE });
    });

    it("counts against the org quota like an upload", async () => {
      const sessionId = await createSession(ctx.orgId, ctx.defaultSpaceId, ctx.user.id);
      const prev = process.env.ORG_STORAGE_QUOTA_BYTES;
      process.env.ORG_STORAGE_QUOTA_BYTES = "1";
      _resetCacheForTesting();
      try {
        await expect(
          createChatFileFromBytes(scope, actor(), sessionId, {
            name: "big.png",
            mime: "image/png",
            bytes: PNG,
            source: SOURCE,
          }),
        ).rejects.toMatchObject({ status: 403, code: "storage_limit_exceeded" });
      } finally {
        if (prev === undefined) delete process.env.ORG_STORAGE_QUOTA_BYTES;
        else process.env.ORG_STORAGE_QUOTA_BYTES = prev;
        _resetCacheForTesting();
      }
      expect((await db.select().from(files).where(eq(files.chatSessionId, sessionId))).length).toBe(
        0,
      );
    });

    it("refuses a conversation that is not the caller's", async () => {
      const other = await createTestUser();
      await addOrgMember(ctx.orgId, other.id, "member");
      const foreign = await createSession(ctx.orgId, ctx.defaultSpaceId, other.id);
      await expect(
        createChatFileFromBytes(scope, actor(), foreign, {
          name: "a.png",
          mime: "image/png",
          bytes: PNG,
          source: SOURCE,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        createChatFileFromBytes(scope, actor(), "chs_missing", {
          name: "a.png",
          mime: "image/png",
          bytes: PNG,
          source: SOURCE,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
