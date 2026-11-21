// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the files MCP surface through the real per-org
 * `/api/mcp/o/:org` HTTP endpoint + in-process dispatch:
 *
 *  - `list_files` returns the caller-visible files (agent outputs +
 *    the caller's own chat uploads), respects `runId` / `purpose` filters, and
 *    does NOT leak another member's private chat-session files.
 *  - `resources/read` on an `appfile://` URI: a small textual doc inlines its
 *    bytes, a binary doc returns metadata only, and a foreign (cross-org) doc is
 *    an MCP error — all through the same container ACL the REST route enforces.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, runs, uploads, chatSessions } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import type { Actor } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpacePackage, seedSpace } from "../../helpers/seed.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import { createFileFromStream, createFileFromUpload } from "../../../src/services/files.ts";
import { zipSync } from "fflate";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { mcpRpc, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";

const app = getTestApp();
await registerTestPlatformApp();

const rpc = mcpRpc(app);

/** Parse the JSON a tool returns in its first text content block. */
function toolData(envelope: JsonRpcEnvelope): { isError: boolean; data: Record<string, unknown> } {
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  const first = content[0];
  return {
    isError: Boolean(envelope.result?.isError),
    data: first ? (JSON.parse(first.text) as Record<string, unknown>) : {},
  };
}

async function apiKeyHeaders(
  ctx: TestContext,
  extraScopes: string[] = [],
): Promise<Record<string, string>> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    // `list_files` / `resources/read` re-dispatch in-process to
    // `GET /api/files*`, which is gated on `files:read` like every
    // other caller — an MCP grant is not a file grant.
    scopes: ["mcp:read", "mcp:invoke", "files:read", ...extraScopes],
  });
  return { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
}

/**
 * The member every seeded run — and every file published from it — is
 * attributed to. Every live launch path carries an actor, and a run-contained
 * file inherits its run's read-ACL, so an actor-less fixture would be
 * unreadable by the very caller these cases drive.
 */
let runOwner: string;

async function seedRun(
  scope: { orgId: string; spaceId: string },
  userId: string = runOwner,
): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    spaceId: scope.spaceId,
    status: "running",
    userId,
  });
  return id;
}

/** Publish an agent_output file with real bytes into the files bucket. */
async function publishDoc(
  scope: { orgId: string; spaceId: string },
  runId: string,
  name: string,
  mime: string,
  content: string | Uint8Array,
  userId: string = runOwner,
): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const { row } = await createFileFromStream(scope, runId, { userId, endUserId: null }, null, {
    name,
    mime,
    body: new Blob([bytes]).stream(),
  });
  return row.id;
}

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: { orgId: string; spaceId: string },
  createdBy: string | null,
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

describe("mcp list_files", () => {
  let ctx: TestContext;
  let scope: { orgId: string; spaceId: string };
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpdocs" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    runOwner = ctx.user.id;
    headers = await apiKeyHeaders(ctx);
  });

  it("returns the run's published files and respects runId + purpose filters", async () => {
    const runA = await seedRun(scope);
    const runB = await seedRun(scope);
    const docA = await publishDoc(scope, runA, "a.txt", "text/plain", "alpha");
    await publishDoc(scope, runB, "b.txt", "text/plain", "bravo");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: { runId: runA } },
    });
    const { data } = toolData(envelope);
    const docs = data.files as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: docA,
      uri: `appfile://${docA}`,
      name: "a.txt",
      mime: "text/plain",
      runId: runA,
      // Each entry carries the same capabilities the REST DTO computes, plus the
      // flat `downloadable` mirror — an agent_output is downloadable by any reader.
      downloadable: true,
    });
    expect(docs[0]!.capabilities as Record<string, unknown>).toMatchObject({
      visible: true,
      metadata: true,
      download: true,
    });
    expect(data.hasMore).toBe(false);

    // purpose=user_upload excludes agent outputs.
    const uploads = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_files", arguments: { purpose: "user_upload" } },
    });
    expect((toolData(uploads.envelope).data.files as unknown[]).length).toBe(0);

    // An undeclared `run_id` argument fails loudly instead of listing unfiltered.
    const undeclared = await rpc(headers, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_files", arguments: { run_id: runA } },
    });
    expect(undeclared.envelope.error).toBeUndefined();
    const refused = toolData(undeclared.envelope);
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ code: "unknown_argument", arguments: ["run_id"] });
    expect(refused.data.error as string).toContain("Unknown argument(s): run_id");
  });

  it("scopes to the caller's org — a foreign org's files are not listed", async () => {
    // The tool resolves the actor + org+space scope from the forwarded auth (same
    // as every other tool), so listFilesForActor never returns another org's
    // rows — the cross-tenant isolation the gallery relies on.
    const runA = await seedRun(scope);
    await publishDoc(scope, runA, "shared.txt", "text/plain", "visible");

    const foreign = await createTestContext({ orgSlug: "foreignorg" });
    const foreignRun = await seedRun(
      { orgId: foreign.orgId, spaceId: foreign.defaultSpaceId },
      foreign.user.id,
    );
    await publishDoc(
      { orgId: foreign.orgId, spaceId: foreign.defaultSpaceId },
      foreignRun,
      "foreign.txt",
      "text/plain",
      "secret",
      foreign.user.id,
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: {} },
    });
    const docs = toolData(envelope).data.files as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.name)).toEqual(["shared.txt"]);
  });

  it("does not leak another member's private chat-session file", async () => {
    // Member B owns a chat session with an attached user_upload. That file is
    // private to B's session — the caller (the API-key's user) must not see it
    // in list_files, even though the files of the caller's own run are listed.
    const memberB = await createTestUser({ email: "mcpchat@docs.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: memberB.id,
    });
    const up = await stageUpload(
      scope,
      memberB.id,
      "bchat.txt",
      new TextEncoder().encode("B private"),
    );
    const chatDoc = await createFileFromUpload(scope, { type: "user", id: memberB.id }, up, {
      chatSessionId: sessionId,
    });

    // A run-contained file is visible as a control.
    const runId = await seedRun(scope);
    const visible = await publishDoc(scope, runId, "vis.txt", "text/plain", "visible");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: {} },
    });
    const docs = toolData(envelope).data.files as Array<Record<string, unknown>>;
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(chatDoc.id);
  });
});

describe("mcp resources/read (appfile://)", () => {
  let ctx: TestContext;
  let scope: { orgId: string; spaceId: string };
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpres" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    runOwner = ctx.user.id;
    headers = await apiKeyHeaders(ctx);
  });

  it("advertises resources without naming an import tool the caller cannot use", async () => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const caps = envelope.result?.capabilities as Record<string, unknown>;
    expect(caps.resources).toBeDefined();
    expect(String(envelope.result?.instructions)).not.toContain("import_package_file");

    const listed = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (listed.envelope.result?.tools as Array<{ name: string }>) ?? [];
    expect(tools.map((tool) => tool.name)).not.toContain("import_package_file");
  });

  it("advertises package import only when the matching tool is available", async () => {
    const importHeaders = await apiKeyHeaders(ctx, ["agents:write"]);
    const initialized = await rpc(importHeaders, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(String(initialized.envelope.result?.instructions)).toContain("import_package_file");

    const listed = await rpc(importHeaders, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (listed.envelope.result?.tools as Array<{ name: string }>) ?? [];
    expect(tools.map((tool) => tool.name)).toContain("import_package_file");
  });

  it("inlines the bytes of a small textual file", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "report.txt", "text/plain", "hello mcp reader");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `appfile://${docId}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      uri: `appfile://${docId}`,
      mimeType: "text/plain",
      text: "hello mcp reader",
    });
  });

  it("reads a file of any reachable space on an org-wide connection: the URI names the space", async () => {
    // Org-wide (no X-Space-Id): a `resources/read` carries no `space_id`, so
    // the file's own space is entered. One file per space, so whichever space
    // the request would otherwise land in, one of the two reads proves it.
    const second = await seedSpace({ orgId: ctx.orgId, name: "Second", visibility: "closed" });
    const secondScope = { orgId: ctx.orgId, spaceId: second.id };
    const docs = [
      await publishDoc(scope, await seedRun(scope), "a.txt", "text/plain", "in default"),
      await publishDoc(secondScope, await seedRun(secondScope), "b.txt", "text/plain", "in second"),
    ];
    const orgWide = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
    for (const [i, docId] of docs.entries()) {
      const { envelope } = await rpc(orgWide, {
        jsonrpc: "2.0",
        id: i,
        method: "resources/read",
        params: { uri: `appfile://${docId}` },
      });
      const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
      expect(contents[0]?.text).toBe(i === 0 ? "in default" : "in second");
    }
  });

  it("requires the file-family grant to read bytes through either MCP entry point", async () => {
    const docId = await publishDoc(
      scope,
      await seedRun(scope),
      "report.txt",
      "text/plain",
      "private-report",
    );
    const uri = `appfile://${docId}`;
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["mcp:read", "mcp:invoke"],
    });
    const limited = { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
    const viaTool = await rpc(limited, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read", arguments: { uri } },
    });
    // Without `files:read` in the file's space the file is as absent as a missing one.
    expect(viaTool.envelope.result?.isError).toBe(true);
    expect(JSON.stringify(viaTool.envelope)).toContain("not_found");
    const direct = await rpc(limited, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    });
    expect(direct.envelope.error?.message).toContain("File not found");
    expect(JSON.stringify([direct.envelope, viaTool.envelope])).not.toContain("private-report");
  });

  it("exposes the same file through the chat-callable read tool", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "report.txt", "text/plain", "hello tool reader");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read", arguments: { uri: `appfile://${docId}` } },
    });
    const content = (envelope.result?.content as Array<Record<string, unknown>>) ?? [];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: "resource",
      resource: {
        uri: `appfile://${docId}`,
        mimeType: "text/plain",
        text: "hello tool reader",
      },
    });
  });

  it("inlines a small non-textual (binary) file as a base64 blob", async () => {
    const runId = await seedRun(scope);
    const raw = "\x00\x01\x02rawbytes";
    const docId = await publishDoc(scope, runId, "blob.bin", "application/octet-stream", raw);

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `appfile://${docId}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    // A small binary downloadable doc now returns a base64 `blob` (not metadata):
    // the read pulls the bytes from storage directly, so S3-presigned deployments
    // no longer degrade to metadata-only.
    expect(contents[0]!.mimeType).toBe("application/octet-stream");
    expect(contents[0]!.text).toBeUndefined();
    const decoded = Buffer.from(contents[0]!.blob as string, "base64");
    expect(decoded).toEqual(Buffer.from(new TextEncoder().encode(raw)));
  });

  it("returns metadata only for a binary file over the 700 KiB blob limit", async () => {
    const runId = await seedRun(scope);
    const big = "B".repeat(700 * 1024 + 16); // non-textual mime, over the blob ceiling
    const docId = await publishDoc(scope, runId, "big.bin", "application/octet-stream", big);

    const { envelope } = await rpc(
      headers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: `appfile://${docId}` },
      },
      "http://api:3000",
    );
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]!.mimeType).toBe("application/json");
    const meta = JSON.parse(contents[0]!.text as string) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: docId, downloadable: true });
    // Metadata-only carries the capabilities and a content URL hint.
    expect((meta.capabilities as Record<string, unknown>).download).toBe(true);
    expect(meta.content_url).toBe(`http://localhost:3000/api/files/${docId}/content`);
    expect(contents[0]!.blob).toBeUndefined();
  });

  it("errors on a foreign (cross-org) file", async () => {
    const foreign = await createTestContext({ orgSlug: "foreignres" });
    const foreignRun = await seedRun({ orgId: foreign.orgId, spaceId: foreign.defaultSpaceId });
    const foreignDoc = await publishDoc(
      { orgId: foreign.orgId, spaceId: foreign.defaultSpaceId },
      foreignRun,
      "secret.txt",
      "text/plain",
      "not yours",
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `appfile://${foreignDoc}` },
    });
    // A file the caller cannot resolve is MCP's "resource not found".
    expect(envelope.error).toMatchObject({
      code: -32002,
      data: { uri: `appfile://${foreignDoc}` },
    });
    expect(envelope.error!.message).toContain("not found");
  });

  it("errors on a malformed file URI", async () => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "appfile://not-a-doc-id" },
    });
    expect(envelope.error).toMatchObject({ code: -32602 });
  });

  it("returns metadata only (no bytes) for another member's user_upload the caller cannot download", async () => {
    // Member B uploads a textual file on a run. The caller (the API-key's
    // user) can resolve the run container but is NOT the upload's creator, so
    // `downloadable` is false — the read serves metadata only, never the bytes.
    const memberB = await createTestUser({ email: "mcpb@docs.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");
    const runId = await seedRun(scope);
    const secretBytes = new TextEncoder().encode("member B private text");
    const realSha = new Bun.CryptoHasher("sha256").update(secretBytes).digest("hex");
    const up = await stageUpload(scope, memberB.id, "secret.txt", secretBytes);
    const actorB: Actor = { type: "user", id: memberB.id };
    const upload = await createFileFromUpload(scope, actorB, up, { runId });

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `appfile://${upload.id}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]!.mimeType).toBe("application/json");
    const meta = JSON.parse(contents[0]!.text as string) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: upload.id, downloadable: false });
    expect(String(meta.note)).toContain("not downloadable");
    // Degraded per the privacy decision: generic name, generic mime, no real
    // hash, no content URL to follow, and the capabilities say metadata is
    // withheld.
    expect(meta.name).toBe("file");
    expect(meta.mime).toBe("application/octet-stream");
    expect(meta.sha256).toBeUndefined();
    expect(meta.content_url).toBeUndefined();
    expect((meta.capabilities as Record<string, unknown>).metadata).toBe(false);
    // Belt-and-braces on the serialized envelope, not just the parsed fields:
    // the private text, the real filename and the real hash leak NOWHERE in
    // the response — a degradation that dropped one of the three would still
    // satisfy the field-by-field assertions above.
    expect(contents[0]!.text).not.toContain("member B private text");
    expect(contents[0]!.text).not.toContain("secret.txt");
    expect(contents[0]!.text).not.toContain(realSha);
  });

  it("returns metadata only for a textual agent_output over the 1 MiB inline limit", async () => {
    const runId = await seedRun(scope);
    const big = "A".repeat(1024 * 1024 + 16); // textual, but > 1 MiB inline ceiling
    const docId = await publishDoc(scope, runId, "big.txt", "text/plain", big);

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `appfile://${docId}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]!.mimeType).toBe("application/json");
    const meta = JSON.parse(contents[0]!.text as string) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: docId, downloadable: true });
    expect(String(meta.note)).toContain("1 MiB");
    // The oversized body is not inlined.
    expect(contents[0]!.text).not.toContain("AAAA");
  });
});

describe("mcp file-backed package workflow", () => {
  let ctx: TestContext;
  let scope: { orgId: string; spaceId: string };
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcppkgdoc" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    runOwner = ctx.user.id;
    headers = await apiKeyHeaders(ctx, ["integrations:write"]);
  });

  it("hides private catalog conflicts and rejects importing a package confined to another space", async () => {
    const hidden = await seedSpace({ orgId: ctx.orgId, visibility: "private" });
    // HOMED in the private space, which is what confines it: the home is a
    // placement, so a package homed where the caller cannot look is a package
    // they cannot reach.
    await seedPackage({
      id: "@mcppkgdoc/file-server",
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: hidden.id,
    });
    await seedSpacePackage(hidden.id, "@mcppkgdoc/file-server");
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "hidden.afps",
      "application/zip",
      packageArchive(true),
    );
    for (const name of ["validate_package_file", "import_package_file"]) {
      const { envelope } = await rpc(headers, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { file_uri: `appfile://${docId}` } },
      });
      const result = toolData(envelope);
      expect(result.isError).toBe(true);
      expect(String(result.data.error)).toContain("not found");
      expect(result.data.conflicts).toBeUndefined();
    }
    const rows = await db
      .select()
      .from(spacePackages)
      .where(eq(spacePackages.packageId, "@mcppkgdoc/file-server"));
    expect(rows.map((row) => row.spaceId)).toEqual([hidden.id]);
  });

  it("places a root homed elsewhere by the same rule the REST import uses", async () => {
    // R7 says a re-import places its root the way `POST /api/spaces/{id}/packages`
    // does: through the placement door when the caller may place it. One act,
    // one rule — this tool asks the same `heldPlacementAuthority` the REST
    // import route asks, off its own request.
    //
    // The fixture homes the root in ANOTHER team space of the organization and
    // places it nowhere else, which is the reachable half of that rule: a
    // session owner reaches every team space, so they hold both the `write`
    // that gets them past `authorizeBundlePackages` and the `share` that
    // decides this, in the home. An API key is pinned to one space and never
    // carries `share` at all, which is why this case is driven by a session.
    const packageId = "@mcppkgdoc/file-server";
    const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
    await seedPackage({
      id: packageId,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: elsewhere.id,
    });

    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "server.afps",
      "application/zip",
      packageArchive(true),
    );

    // On the organization endpoint: one pinned to a space reaches that space alone.
    const sessionHeaders = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
    const { envelope } = await rpc(sessionHeaders, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "import_package_file",
        arguments: { file_uri: `appfile://${docId}`, space_id: ctx.defaultSpaceId },
      },
    });
    const result = toolData(envelope);
    expect(result.isError, JSON.stringify(envelope)).toBe(false);
    expect(result.data).toMatchObject({ root_package_id: packageId, root_active: true });

    // The placement, switched on and naming its placer — asserting only the
    // flag would pass on an install that wrote no row.
    const installs = await db
      .select({
        spaceId: spacePackages.spaceId,
        enabled: spacePackages.enabled,
        sharedBy: spacePackages.sharedBy,
      })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, packageId));
    expect(installs).toEqual([
      { spaceId: ctx.defaultSpaceId, enabled: true, sharedBy: ctx.user.id },
    ]);
  });

  it("the chat bearer imports in the one space it entered: a root homed in another is out of reach", async () => {
    const packageId = "@mcppkgdoc/file-server";
    const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
    await seedPackage({
      id: packageId,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: elsewhere.id,
    });
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "server.afps",
      "application/zip",
      packageArchive(true),
    );
    // Bound to both spaces with the owner's grants: a session would place the root, as above.
    const bearer = loopbackHeaders(ctx, ctx.orgId, {
      orgRole: "owner",
      permissions: [
        "mcp:read",
        "mcp:invoke",
        "files:read",
        "integrations:read",
        "integrations:write",
        "integrations:share",
        "integrations:install",
      ],
      spaceIds: [ctx.defaultSpaceId, elsewhere.id],
    });
    const { envelope } = await rpc(bearer, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "import_package_file",
        arguments: { file_uri: `appfile://${docId}`, space_id: ctx.defaultSpaceId },
      },
    });
    const result = toolData(envelope);
    // The refusal of a package outside the caller's reach: the opaque not-found.
    expect(result).toEqual({
      isError: true,
      data: { error: `Package '${packageId}' not found` },
    });
    const rows = await db
      .select({ spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, packageId));
    expect(rows).toEqual([]);
  });

  function packageArchive(includeEntryPoint: boolean, source = "// server\n"): Uint8Array {
    const packageId = "@mcppkgdoc/file-server";
    const manifest = localIntegrationManifest({
      name: packageId,
      version: "1.0.0",
      server: { entryPoint: "main.js" },
      auths: { api: { type: "api_key" } },
    });
    const entries: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    };
    if (includeEntryPoint) entries["main.js"] = new TextEncoder().encode(source);
    return zipSync(entries as unknown as Parameters<typeof zipSync>[0]);
  }

  it("refuses to read the archive of a caller without files:read", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "invalid.afps",
      "application/zip",
      packageArchive(false),
    );
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["mcp:read", "mcp:invoke"],
    });
    const { envelope } = await rpc(
      { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "validate_package_file", arguments: { file_uri: `appfile://${docId}` } },
      },
    );
    const result = toolData(envelope);
    expect(result.isError).toBe(true);
    // Refused before the bytes are read, as a missing file: no validation verdict comes back.
    expect(result.data).toMatchObject({ code: "not_found" });
    expect(result.data.valid).toBeUndefined();
  });

  it("validates without writing and reports a missing entry point", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "invalid.afps",
      "application/zip",
      packageArchive(false),
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate_package_file",
        arguments: { file_uri: `appfile://${docId}` },
      },
    });
    const result = toolData(envelope);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ valid: false, importable: false });
    expect(String(result.data.error)).toContain("main.js");
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  it("reports a skill whose SKILL.md declares no description", async () => {
    const manifest = {
      name: "@mcppkgdoc/gate-skill",
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "Gate Skill",
      description: "A gated skill.",
    };
    const bytes = zipSync({
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      // A conforming name but no `description` — an artifact no agent runtime
      // can decide to invoke.
      "SKILL.md": new TextEncoder().encode("---\nname: gate-skill\n---\nBody."),
    } as unknown as Parameters<typeof zipSync>[0]);

    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "gate-skill.afps", "application/zip", bytes);

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate_package_file",
        arguments: { file_uri: `appfile://${docId}` },
      },
    });
    const result = toolData(envelope);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ valid: false, importable: false });
    expect(String(result.data.error)).toContain("description");
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  // The preflight is the import's own: a reserved scope must not read as
  // importable here and then be refused by `import_package_file`.
  it("reports a package under a platform-reserved scope as not importable", async () => {
    const manifest = {
      name: "@inline/evil",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.1",
      display_name: "Squatter",
      description: "Claims the inline scope.",
    };
    const bytes = zipSync({
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
      "prompt.md": new TextEncoder().encode("You are a squatter."),
    } as unknown as Parameters<typeof zipSync>[0]);

    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "evil.afps", "application/zip", bytes);

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate_package_file",
        arguments: { file_uri: `appfile://${docId}` },
      },
    });
    const result = toolData(envelope);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ valid: false, importable: false });
    expect(String(result.data.error)).toContain("reserved scope");
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  it("validates then imports and installs a package without exposing its bytes to the model", async () => {
    const packageId = "@mcppkgdoc/file-server";
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "server.afps",
      "application/zip",
      packageArchive(true),
    );

    const validated = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate_package_file",
        arguments: { file_uri: `appfile://${docId}` },
      },
    });
    expect(toolData(validated.envelope).data).toMatchObject({
      valid: true,
      importable: true,
      root: `${packageId}@1.0.0`,
    });

    const imported = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "import_package_file",
        arguments: { file_uri: `appfile://${docId}` },
      },
    });
    const result = toolData(imported.envelope);
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ root_package_id: packageId, root_version: "1.0.0" });

    const [stored] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.id, packageId));
    expect(stored?.id).toBe(packageId);
    const [installed] = await db
      .select({ packageId: spacePackages.packageId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, packageId));
    expect(installed?.packageId).toBe(packageId);

    const conflictDocId = await publishDoc(
      scope,
      runId,
      "conflict.afps",
      "application/zip",
      packageArchive(true, "// different server bytes\n"),
    );
    const conflicted = await rpc(headers, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_package_file",
        arguments: { file_uri: `appfile://${conflictDocId}` },
      },
    });
    expect(toolData(conflicted.envelope).data).toMatchObject({
      valid: true,
      importable: false,
      conflicts: [{ identity: `${packageId}@1.0.0` }],
    });
  });
});

describe("mcp file reads of a chat conversation's own attachments", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpchatfiles" });
    runOwner = ctx.user.id;
  });

  /** A chat upload of `userId`, held by conversation `sessionId`, in their personal space. */
  async function chatUpload(userId: string, sessionId: string, content: string): Promise<string> {
    const personal = await ensurePersonalSpaceFor(ctx.orgId, userId);
    const scope = { orgId: ctx.orgId, spaceId: personal.id };
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId });
    const upload = await stageUpload(scope, userId, "notes.csv", new TextEncoder().encode(content));
    const file = await createFileFromUpload(scope, { type: "user", id: userId }, upload, {
      chatSessionId: sessionId,
    });
    return `appfile://${file.id}`;
  }

  it("a limited conversation's bearer reads its own personal-space upload, and no other file", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    const own = await chatUpload(ctx.user.id, sessionId, "a,b\n1,2");
    const otherConversation = await chatUpload(
      ctx.user.id,
      `chs_${crypto.randomUUID()}`,
      "autre conversation",
    );
    const colleague = await createTestUser({ email: "colleague@mcp-chat-files.test" });
    await addOrgMember(ctx.orgId, colleague.id, "member");
    const theirs = await chatUpload(colleague.id, `chs_${crypto.randomUUID()}`, "leur fichier");

    // The bearer of a turn limited to the default space: the personal space is not its.
    const bearer = (chatSessionId?: string) =>
      loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: ["mcp:read", "mcp:invoke", "files:read"],
        spaceIds: [ctx.defaultSpaceId],
        chatSessionId,
      });
    const readFile = async (headers: Record<string, string>, uri: string) => {
      const { envelope } = await rpc(headers, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read", arguments: { uri, space_id: ctx.defaultSpaceId } },
      });
      return envelope;
    };
    const readResource = async (headers: Record<string, string>, uri: string) =>
      (await rpc(headers, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }))
        .envelope;

    const viaTool = await readFile(bearer(sessionId), own);
    expect(viaTool.result?.isError).toBe(false);
    expect(JSON.stringify(viaTool.result?.content)).toContain("a,b\\n1,2");
    const direct = await readResource(bearer(sessionId), own);
    expect((direct.result?.contents as Array<{ text?: string }>)?.[0]?.text).toBe("a,b\n1,2");

    // Another conversation's file, another member's, or no conversation at all: as missing.
    for (const [headers, uri] of [
      [bearer(sessionId), otherConversation],
      [bearer(sessionId), theirs],
      [bearer(), own],
    ] as const) {
      const refused = await readFile(headers, uri);
      expect(refused.result?.isError).toBe(true);
      expect(JSON.stringify(refused.result?.content)).toContain("not_found");
      expect(JSON.stringify(refused)).not.toMatch(/a,b|autre conversation|leur fichier/);
      const refusedDirect = await readResource(headers, uri);
      expect(refusedDirect.result).toBeUndefined();
    }
  });
});

describe("the content_url of an oversized MCP file read", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpcontenturl" });
    runOwner = ctx.user.id;
  });

  /** `read` from the default space, answered as metadata; returns its `content_url`. */
  async function contentUrlOf(headers: Record<string, string>, uri: string): Promise<string> {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read", arguments: { uri, space_id: ctx.defaultSpaceId } },
    });
    const content = envelope.result?.content as Array<{ resource: { text: string } }>;
    const meta = JSON.parse(content[0]!.resource.text) as { content_url: string };
    return new URL(meta.content_url).pathname;
  }

  /** Follow it as the same caller, in the space it entered. */
  const follow = (headers: Record<string, string>, path: string) =>
    app.request(path, { headers: { ...headers, "X-Space-Id": ctx.defaultSpaceId } });

  it("serves a file of another space to a session that reached it", async () => {
    const other = await seedSpace({ orgId: ctx.orgId, name: "Autre", visibility: "closed" });
    const otherScope = { orgId: ctx.orgId, spaceId: other.id };
    const big = "B".repeat(700 * 1024 + 16);
    const docId = await publishDoc(
      otherScope,
      await seedRun(otherScope),
      "big.bin",
      "application/octet-stream",
      big,
    );
    const session = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };

    const path = await contentUrlOf(session, `appfile://${docId}`);
    const res = await follow(session, path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(big);
    // Its metadata door follows the same rule.
    expect((await follow(session, `/api/files/${docId}`)).status).toBe(200);

    // An API key bound to the default space reaches no other: as missing.
    const key = await apiKeyHeaders(ctx);
    expect((await follow(key, path)).status).toBe(404);
    expect((await follow(key, `/api/files/${docId}`)).status).toBe(404);
  });

  it("serves a limited conversation's own personal upload to its bearer, and to no other", async () => {
    const sessionId = `chs_${crypto.randomUUID()}`;
    const personal = await ensurePersonalSpaceFor(ctx.orgId, ctx.user.id);
    const scope = { orgId: ctx.orgId, spaceId: personal.id };
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: ctx.user.id });
    const big = "a,b\n".repeat(300 * 1024);
    const upload = await stageUpload(scope, ctx.user.id, "big.csv", new TextEncoder().encode(big));
    const file = await createFileFromUpload(scope, { type: "user", id: ctx.user.id }, upload, {
      chatSessionId: sessionId,
    });
    const bearer = (chatSessionId?: string) =>
      loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: ["mcp:read", "mcp:invoke", "files:read"],
        spaceIds: [ctx.defaultSpaceId],
        chatSessionId,
      });

    const path = await contentUrlOf(bearer(sessionId), `appfile://${file.id}`);
    const res = await follow(bearer(sessionId), path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(big);
    // The bearer of another turn naming no conversation does not reach it.
    expect((await follow(bearer(), path)).status).toBe(404);
  });
});
