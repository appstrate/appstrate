// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP authoring loop — pull_package_files / package_status /
 * push_package_files — through the real `/api/mcp/o/:org` endpoint. What the
 * CLI's `skills pull` / `status` / `push` do, for a caller that only has MCP.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { setPlatformApp } from "../../../src/lib/platform-app.ts";
import { resetCatalog } from "../../../src/modules/mcp/catalog.ts";

const app = getTestApp();
setPlatformApp(app);

const MCP_ACCEPT = "application/json, text/event-stream";
const PACKAGE_ID = "@mcporg/pdf-tools";
const SKILL_MD = "---\nname: pdf-tools\ndescription: Work with PDFs.\n---\n\nBody one.\n";

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<JsonRpcEnvelope> {
  const res = await app.request(`/api/mcp/o/${headers["X-Org-Id"]}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return text ? (JSON.parse(text) as JsonRpcEnvelope) : {};
}

let nextId = 1;
async function callTool(
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const envelope = await rpc(headers, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (envelope.error) throw new Error(`rpc error: ${envelope.error.message}`);
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  return {
    isError: Boolean(envelope.result?.isError),
    data: content[0] ? (JSON.parse(content[0].text) as Record<string, unknown>) : {},
  };
}

async function listToolNames(headers: Record<string, string>): Promise<string[]> {
  const envelope = await rpc(headers, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/list",
    params: {},
  });
  return ((envelope.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
}

async function apiKeyHeaders(ctx: TestContext, scopes: string[]): Promise<Record<string, string>> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
}

async function versionCount(): Promise<number> {
  return (await db.select().from(packageVersions).where(eq(packageVersions.packageId, PACKAGE_ID)))
    .length;
}

describe("MCP package drafts — pull, status, push", () => {
  let ctx: TestContext;
  let writer: Record<string, string>;
  let reader: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
    ctx = await createTestContext({ orgSlug: "mcporg" });
    writer = await apiKeyHeaders(ctx, [
      "mcp:read",
      "mcp:invoke",
      "agents:read",
      "agents:write",
      "skills:read",
      "skills:write",
      "spaces:read",
    ]);
    reader = await apiKeyHeaders(ctx, [
      "mcp:read",
      "mcp:invoke",
      "agents:read",
      "skills:read",
      "spaces:read",
    ]);
  });

  it("offers push only to a caller allowed to write packages", async () => {
    const withWrite = await listToolNames(writer);
    expect(withWrite).toEqual(
      expect.arrayContaining(["pull_package_files", "package_status", "push_package_files"]),
    );
    const readOnly = await listToolNames(reader);
    expect(readOnly).toContain("pull_package_files");
    expect(readOnly).not.toContain("push_package_files");
  });

  it("creates a draft from files, annex included, then pulls it back with its lock", async () => {
    const pushed = await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "#!/bin/sh\necho one\n" },
    });
    expect(pushed.isError).toBe(false);
    expect(pushed.data).toMatchObject({
      packageId: PACKAGE_ID,
      draft: true,
      draftVersion: "1.0.0",
    });
    expect(typeof pushed.data.lock_version).toBe("number");
    expect(await versionCount()).toBe(0);

    const pulled = await callTool(writer, "pull_package_files", { package_id: PACKAGE_ID });
    expect(pulled.isError).toBe(false);
    const files = pulled.data.files as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "manifest.json", "scripts/run.sh"]);
    expect(files["scripts/run.sh"]).toBe("#!/bin/sh\necho one\n");
    expect(pulled.data.lock_version).toBe(pushed.data.lock_version);
    expect(JSON.parse(files["manifest.json"]!)).toMatchObject({
      name: PACKAGE_ID,
      version: "1.0.0",
    });
  });

  it("re-pushes with the lock it holds, reports status, and refuses a stale lock", async () => {
    const first = await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "echo one\n" },
    });
    const lock = first.data.lock_version as number;

    const status = await callTool(writer, "package_status", {
      package_id: PACKAGE_ID,
      files: {
        "SKILL.md": SKILL_MD,
        "scripts/run.sh": "echo two\n",
        "references/guide.md": "# G\n",
      },
      lock_version: lock,
    });
    expect(status.data).toMatchObject({ clean: false, draft_edited_elsewhere: false });
    expect(status.data.changes).toEqual([
      { path: "references/guide.md", change: "added" },
      { path: "scripts/run.sh", change: "modified" },
    ]);

    const second = await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: {
        "SKILL.md": SKILL_MD,
        "scripts/run.sh": "echo two\n",
        "references/guide.md": "# G\n",
      },
      lock_version: lock,
    });
    expect(second.isError).toBe(false);
    expect(second.data.lock_version as number).toBeGreaterThan(lock);

    // The chat edits the draft in between: the old lock is stale.
    const edited = await app.request(`/api/packages/skills/${PACKAGE_ID}`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        content: SKILL_MD.replace("Body one.", "Chat edit."),
        lock_version: second.data.lock_version,
      }),
    });
    expect(edited.status).toBe(200);

    const stale = await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "echo three\n" },
      lock_version: second.data.lock_version,
    });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ status: 409, code: "draft_overwrite" });
    expect(String(stale.data.hint)).toContain("force: true");

    const moved = await callTool(writer, "package_status", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD },
      lock_version: second.data.lock_version,
    });
    expect(moved.data.draft_edited_elsewhere).toBe(true);

    const forced = await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "echo three\n" },
      lock_version: second.data.lock_version,
      force: true,
    });
    expect(forced.isError).toBe(false);
    expect(await versionCount()).toBe(0);
  });

  it("publishes the draft through the ordinary versions operation, annex files included", async () => {
    await callTool(writer, "push_package_files", {
      package_id: PACKAGE_ID,
      files: { "SKILL.md": SKILL_MD, "scripts/run.sh": "echo one\n" },
    });
    const published = await callTool(writer, "invoke_operation", {
      operation_id: "createSkillVersion",
      path_params: { scope: "@mcporg", name: "pdf-tools" },
      body: {},
    });
    expect(published.isError).toBe(false);
    expect(await versionCount()).toBe(1);

    const pulledVersion = await callTool(writer, "pull_package_files", {
      package_id: PACKAGE_ID,
      version: "1.0.0",
    });
    expect(Object.keys(pulledVersion.data.files as Record<string, string>).sort()).toEqual([
      "SKILL.md",
      "manifest.json",
      "scripts/run.sh",
    ]);
  });

  it("refuses the write tool to a read-only caller and a traversing path to everyone", async () => {
    const denied = await rpc(reader, {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "push_package_files",
        arguments: { package_id: PACKAGE_ID, files: { "SKILL.md": SKILL_MD } },
      },
    });
    expect(denied.error?.code ?? denied.result?.isError).toBeTruthy();

    const traversal = await rpc(writer, {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "push_package_files",
        arguments: { package_id: PACKAGE_ID, files: { "SKILL.md": SKILL_MD, "../evil.sh": "x" } },
      },
    });
    expect(traversal.error?.message ?? "").toContain("Refusing path");
  });
});
