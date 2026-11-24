// SPDX-License-Identifier: Apache-2.0

/**
 * Against the REAL platform, the chat bearer (bound to the turn's spaces) reads a file in the one
 * space a call entered, and that space is the one the conversation records: a file of another
 * turn space is the 404 of a missing one there. In its own space, a colleague's private run
 * output stays behind its container ACL.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { seedRun } from "../../../apps/api/test/helpers/seed.ts";
import { orgPermissions, presetPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { createFileFromStream } from "../../../apps/api/src/services/files.ts";
import { ensurePersonalSpaceFor } from "../../../apps/api/src/services/spaces.ts";
import { parseFileUri } from "@appstrate/core/file-uri";
import { db } from "@appstrate/db/client";
import { chatSessions, files } from "@appstrate/db/schema";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { fileSpaceId, touchedSpaceIds, touchSessionSpace } from "../src/persistence.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools, type TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ORIGIN = "http://localhost";
const platformFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  app.request(input instanceof URL ? input.toString() : input, init)) as typeof fetch;

interface FileTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

let colleague: TestContext;
let caller: TestContext;
/** An operator: `files:read` in the space, but no `runs:read-all`. */
let permissions: string[];

beforeEach(async () => {
  await truncateAll();
  colleague = await createTestContext();
  caller = await memberContext(colleague, "member", "operator");
  permissions = [...new Set([...orgPermissions("member"), ...presetPermissions("operator")])];
});

/** A run output of `owner`'s own run in the shared space. */
async function runOutput(owner: TestContext): Promise<string> {
  const scope = { orgId: colleague.orgId, spaceId: colleague.defaultSpaceId };
  const run = await seedRun({ ...scope, userId: owner.user.id });
  const { row } = await createFileFromStream(
    scope,
    run.id,
    { userId: owner.user.id, endUserId: null },
    null,
    { name: "out.txt", mime: "text/plain", body: new Blob(["x"]).stream() },
  );
  return `appfile://${row.id}`;
}

/** `read` and `read_resource` of a turn over the caller's personal space and the shared space. */
async function fileTools() {
  const sessionId = `chs_${crypto.randomUUID()}`;
  const session = {
    id: sessionId,
    orgId: caller.orgId,
    userId: caller.user.id,
    originSpaceId: null,
  };
  await db
    .insert(chatSessions)
    .values({ id: sessionId, orgId: caller.orgId, userId: caller.user.id });
  const personal = (await ensurePersonalSpaceFor(caller.orgId, caller.user.id)).id;
  const organization: TurnSpaces = {
    spaces: [
      { id: personal, name: "Mon espace", role: "admin", permissions },
      { id: colleague.defaultSpaceId, name: "Default", role: "operator", permissions },
    ],
    touch: (spaceId) => touchSessionSpace(session, spaceId),
    fileSpace: async (uri) => {
      const fileId = parseFileUri(uri);
      return fileId
        ? fileSpaceId(colleague.orgId, fileId, { chatSessionId: null, personalSpaceId: null })
        : undefined;
    },
  };
  const token = mintMcpLoopbackToken({
    userId: caller.user.id,
    email: caller.user.email,
    name: caller.user.name,
    orgId: caller.orgId,
    orgRole: "member",
    chatSessionId: sessionId,
    permissions,
    spaceIds: organization.spaces.map((space) => space.id),
  });
  const built = await buildPlatformMcpTools({
    url: platformMcpUrl(ORIGIN, caller.orgId),
    headers: { Authorization: `Bearer ${token}`, "x-org-id": caller.orgId },
    organization,
    writeChunk: () => {},
    fileDelivery: { image: false, pdf: false },
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
    fetch: platformFetch,
  });
  const registered = new Map<string, FileTool>();
  const pi = {
    registerTool: (tool: FileTool) => registered.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  return {
    built,
    touched: async () => (await touchedSpaceIds([sessionId])).get(sessionId) ?? [],
    readFile: (uri: string, spaceId: string) =>
      registered.get("read")!.execute("c1", { uri, space_id: spaceId }),
    readResource: (uri: string) => registered.get("read_resource")!.execute("c2", { uri }),
    personal,
  };
}

describe("a chat call reads a file in the one space it entered", () => {
  it("records that space, and refuses a file of another turn space as missing", async () => {
    const { built, readFile, personal, touched } = await fileTools();
    try {
      const own = await runOutput(caller);
      // Entered from the personal space, a file of the shared space is not reached.
      expect((await readFile(own, personal)).content[0]!.text).toContain("not_found");
      expect(await touched()).toEqual([personal]);
      // Entered in its own space it is read, and that space is the one recorded.
      expect((await readFile(own, colleague.defaultSpaceId)).content[0]!.text).not.toContain(
        "not_found",
      );
      expect(await touched()).toEqual([personal, colleague.defaultSpaceId]);
      // There, a colleague's private output stays behind its container ACL.
      const theirs = await runOutput(colleague);
      expect((await readFile(theirs, colleague.defaultSpaceId)).content[0]!.text).toContain(
        "not_found",
      );
    } finally {
      await built.close();
    }
  });

  it("records the space of a file resource it read, and nothing for one it is refused", async () => {
    const { built, readResource, touched } = await fileTools();
    try {
      // A colleague's private output in a turn space: refused, and its space is not recorded.
      const refused = await readResource(await runOutput(colleague)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
      expect(await touched()).toEqual([]);
      const read = await readResource(await runOutput(caller));
      expect(read.content.map((block) => block.text).join("")).toContain("x");
      expect(await touched()).toEqual([colleague.defaultSpaceId]);
    } finally {
      await built.close();
    }
  });
});

describe("fileSpaceId", () => {
  /** A file `chatSessionId` holds in `spaceId`. */
  async function heldFile(spaceId: string, chatSessionId: string): Promise<string> {
    const id = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.insert(files).values({
      id,
      orgId: colleague.orgId,
      spaceId,
      purpose: "user_upload",
      chatSessionId,
      userId: caller.user.id,
      storageKey: `files/${spaceId}/${id}/a.txt`,
      name: "a.txt",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
    });
    return id;
  }

  it("names no space for the conversation's own file in the personal space, and the team space of one held there", async () => {
    const personalSpaceId = (await ensurePersonalSpaceFor(caller.orgId, caller.user.id)).id;
    const chatSessionId = `chs_${crypto.randomUUID()}`;
    await db
      .insert(chatSessions)
      .values({ id: chatSessionId, orgId: colleague.orgId, userId: caller.user.id });
    const conversation = { chatSessionId, personalSpaceId };
    const personal = await heldFile(personalSpaceId, chatSessionId);
    const team = await heldFile(colleague.defaultSpaceId, chatSessionId);
    expect(await fileSpaceId(colleague.orgId, personal, conversation)).toBeUndefined();
    expect(await fileSpaceId(colleague.orgId, team, conversation)).toBe(colleague.defaultSpaceId);
  });
});
