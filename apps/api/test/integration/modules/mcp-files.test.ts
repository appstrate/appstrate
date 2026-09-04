// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the files MCP surface through the real per-org
 * `/api/mcp/o/:org` HTTP endpoint + in-process dispatch:
 *
 *  - `list_files` returns the caller-visible files (agent outputs +
 *    the caller's own chat uploads), respects `run_id` / `purpose` filters, and
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
import { seedApiKey } from "../../helpers/seed.ts";
import { setPlatformApp } from "../../../src/lib/platform-app.ts";
import { resetCatalog } from "../../../src/modules/mcp/catalog.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import { createFileFromStream, createFileFromUpload } from "../../../src/services/files.ts";
import { zipSync } from "fflate";
import { mcpServerManifest } from "../../helpers/integration-manifests.ts";

const app = getTestApp();
setPlatformApp(app);

const MCP_ACCEPT = "application/json, text/event-stream";

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(
  headers: Record<string, string>,
  message: Record<string, unknown>,
  requestOrigin = "",
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request(`${requestOrigin}/api/mcp/o/${headers["X-Org-Id"]}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
}

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

async function seedRun(scope: { orgId: string; spaceId: string }): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    spaceId: scope.spaceId,
    status: "running",
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
): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const { row } = await createFileFromStream(
    scope,
    runId,
    { userId: null, endUserId: null },
    null,
    { name, mime, body: new Blob([bytes]).stream() },
  );
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
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcpdocs" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    headers = await apiKeyHeaders(ctx);
  });

  it("returns the run's published files and respects run_id + purpose filters", async () => {
    const runA = await seedRun(scope);
    const runB = await seedRun(scope);
    const docA = await publishDoc(scope, runA, "a.txt", "text/plain", "alpha");
    await publishDoc(scope, runB, "b.txt", "text/plain", "bravo");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_files", arguments: { run_id: runA } },
    });
    const { data } = toolData(envelope);
    const docs = data.files as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: docA,
      uri: `appfile://${docA}`,
      name: "a.txt",
      mime: "text/plain",
      run_id: runA,
      // Each entry carries the same capabilities the REST DTO computes, plus the
      // flat `downloadable` mirror — an agent_output is downloadable by any reader.
      downloadable: true,
    });
    expect(docs[0]!.capabilities as Record<string, unknown>).toMatchObject({
      visible: true,
      metadata: true,
      download: true,
    });
    expect(data.has_more).toBe(false);

    // purpose=user_upload excludes agent outputs.
    const uploads = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_files", arguments: { purpose: "user_upload" } },
    });
    expect((toolData(uploads.envelope).data.files as unknown[]).length).toBe(0);
  });

  it("scopes to the caller's org — a foreign org's files are not listed", async () => {
    // The tool resolves the actor + org+space scope from the forwarded auth (same
    // as every other tool), so listFilesForActor never returns another org's
    // rows — the cross-tenant isolation the gallery relies on.
    const runA = await seedRun(scope);
    await publishDoc(scope, runA, "shared.txt", "text/plain", "visible");

    const foreign = await createTestContext({ orgSlug: "foreignorg" });
    const foreignRun = await seedRun({ orgId: foreign.orgId, spaceId: foreign.defaultSpaceId });
    await publishDoc(
      { orgId: foreign.orgId, spaceId: foreign.defaultSpaceId },
      foreignRun,
      "foreign.txt",
      "text/plain",
      "secret",
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
    // private to B's session — the caller (the API-key's user) must not see it in
    // list_files, even though a run-contained file IS org-visible.
    const memberB = await createTestUser({ email: "mcpchat@docs.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcpres" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
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

  it("exposes the same file through the chat-callable read_file tool", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "report.txt", "text/plain", "hello tool reader");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: { uri: `appfile://${docId}` } },
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
    // A cross-org id resolves to a 404 in the route → surfaced as an MCP error.
    expect(envelope.error).toBeDefined();
    expect(envelope.error!.message).toContain("not found");
  });

  it("errors on a malformed file URI", async () => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "appfile://not-a-doc-id" },
    });
    expect(envelope.error).toBeDefined();
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
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcppkgdoc" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    headers = await apiKeyHeaders(ctx, ["agents:write"]);
  });

  function packageArchive(includeEntryPoint: boolean, source = "// server\n"): Uint8Array {
    const packageId = "@mcppkgdoc/file-server";
    const manifest = mcpServerManifest({
      name: packageId,
      version: "1.0.0",
      entryPoint: "main.js",
    });
    const entries: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    };
    if (includeEntryPoint) entries["main.js"] = new TextEncoder().encode(source);
    return zipSync(entries as unknown as Parameters<typeof zipSync>[0]);
  }

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
