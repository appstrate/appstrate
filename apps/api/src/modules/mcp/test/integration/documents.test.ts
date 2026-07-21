// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the documents MCP surface through the real per-org
 * `/api/mcp/o/:org` HTTP endpoint + in-process dispatch:
 *
 *  - `list_documents` returns the caller-visible documents (agent outputs +
 *    the caller's own chat uploads), respects `run_id` / `purpose` filters, and
 *    does NOT leak another member's private chat-session documents.
 *  - `resources/read` on a `document://` URI: a small textual doc inlines its
 *    bytes, a binary doc returns metadata only, and a foreign (cross-org) doc is
 *    an MCP error — all through the same container ACL the REST route enforces.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../../../test/helpers/auth.ts";
import { seedApiKey } from "../../../../../test/helpers/seed.ts";
import { setPlatformApp } from "../../../../lib/platform-app.ts";
import { resetCatalog } from "../../catalog.ts";
import { createDocumentFromStream } from "../../../../services/documents.ts";

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
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request(`/api/mcp/o/${headers["X-Org-Id"]}`, {
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

async function apiKeyHeaders(ctx: TestContext): Promise<Record<string, string>> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes: ["mcp:read", "mcp:invoke"],
  });
  return { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
}

async function seedRun(scope: { orgId: string; applicationId: string }): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    status: "running",
  });
  return id;
}

/** Publish an agent_output document with real bytes into the documents bucket. */
async function publishDoc(
  scope: { orgId: string; applicationId: string },
  runId: string,
  name: string,
  mime: string,
  content: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const { row } = await createDocumentFromStream(
    scope,
    runId,
    { userId: null, endUserId: null },
    null,
    { name, mime, body: new Blob([bytes]).stream() },
  );
  return row.id;
}

describe("mcp list_documents", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcpdocs" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    headers = await apiKeyHeaders(ctx);
  });

  it("returns the run's published documents and respects run_id + purpose filters", async () => {
    const runA = await seedRun(scope);
    const runB = await seedRun(scope);
    const docA = await publishDoc(scope, runA, "a.txt", "text/plain", "alpha");
    await publishDoc(scope, runB, "b.txt", "text/plain", "bravo");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_documents", arguments: { run_id: runA } },
    });
    const { data } = toolData(envelope);
    const docs = data.documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: docA,
      uri: `document://${docA}`,
      name: "a.txt",
      mime: "text/plain",
      run_id: runA,
    });
    expect(data.has_more).toBe(false);

    // purpose=user_upload excludes agent outputs.
    const uploads = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_documents", arguments: { purpose: "user_upload" } },
    });
    expect((toolData(uploads.envelope).data.documents as unknown[]).length).toBe(0);
  });

  it("scopes to the caller's org — a foreign org's documents are not listed", async () => {
    // The tool resolves the actor + org+app scope from the forwarded auth (same
    // as every other tool), so listDocumentsForActor never returns another org's
    // rows — the cross-tenant isolation the gallery relies on.
    const runA = await seedRun(scope);
    await publishDoc(scope, runA, "shared.txt", "text/plain", "visible");

    const foreign = await createTestContext({ orgSlug: "foreignorg" });
    const foreignRun = await seedRun({ orgId: foreign.orgId, applicationId: foreign.defaultAppId });
    await publishDoc(
      { orgId: foreign.orgId, applicationId: foreign.defaultAppId },
      foreignRun,
      "foreign.txt",
      "text/plain",
      "secret",
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_documents", arguments: {} },
    });
    const docs = toolData(envelope).data.documents as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.name)).toEqual(["shared.txt"]);
  });
});

describe("mcp resources/read (document://)", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };
  let headers: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcpres" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    headers = await apiKeyHeaders(ctx);
  });

  it("advertises the resources capability at initialize", async () => {
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
  });

  it("inlines the bytes of a small textual document", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(scope, runId, "report.txt", "text/plain", "hello mcp reader");

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `document://${docId}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      uri: `document://${docId}`,
      mimeType: "text/plain",
      text: "hello mcp reader",
    });
  });

  it("returns metadata only for a non-textual (binary) document", async () => {
    const runId = await seedRun(scope);
    const docId = await publishDoc(
      scope,
      runId,
      "blob.bin",
      "application/octet-stream",
      "\x00\x01\x02rawbytes",
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `document://${docId}` },
    });
    const contents = (envelope.result?.contents as Array<Record<string, unknown>>) ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0]!.mimeType).toBe("application/json");
    const meta = JSON.parse(contents[0]!.text as string) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: docId, mime: "application/octet-stream", downloadable: true });
    expect(String(meta.note)).toContain("binary");
  });

  it("errors on a foreign (cross-org) document", async () => {
    const foreign = await createTestContext({ orgSlug: "foreignres" });
    const foreignRun = await seedRun({ orgId: foreign.orgId, applicationId: foreign.defaultAppId });
    const foreignDoc = await publishDoc(
      { orgId: foreign.orgId, applicationId: foreign.defaultAppId },
      foreignRun,
      "secret.txt",
      "text/plain",
      "not yours",
    );

    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `document://${foreignDoc}` },
    });
    // A cross-org id resolves to a 404 in the route → surfaced as an MCP error.
    expect(envelope.error).toBeDefined();
    expect(envelope.error!.message).toContain("not found");
  });

  it("errors on a malformed document URI", async () => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "document://not-a-doc-id" },
    });
    expect(envelope.error).toBeDefined();
  });
});
