// SPDX-License-Identifier: Apache-2.0

/**
 * The space of a file a chat call names is recorded only once the REAL platform served the
 * call: a colleague's private run output, in a space where the caller reads files, is refused
 * by its container ACL and records nothing; the caller's own run output there is recorded.
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
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { fileSpaceIds } from "../src/persistence.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools, type TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ORIGIN = "http://localhost";
const platformFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  app.request(input instanceof URL ? input.toString() : input, init)) as typeof fetch;

interface ReadFile {
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

/** `read_file` of a turn over the caller's personal space, where each call is dispatched, and the shared space. */
async function readFileTool(touched: string[]) {
  const personal = (await ensurePersonalSpaceFor(caller.orgId, caller.user.id)).id;
  const organization: TurnSpaces = {
    spaces: [
      { id: personal, name: "Mon espace", role: "admin", permissions },
      { id: colleague.defaultSpaceId, name: "Default", role: "operator", permissions },
    ],
    touch: async (space) => {
      touched.push(space);
    },
    fileSpaces: (uris) =>
      fileSpaceIds(
        colleague.orgId,
        uris.flatMap((uri) => parseFileUri(uri) ?? []),
        null,
      ),
  };
  const token = mintMcpLoopbackToken({
    userId: caller.user.id,
    email: caller.user.email,
    name: caller.user.name,
    orgId: caller.orgId,
    orgRole: "member",
    permissions,
    spaceIds: organization.spaces.map((space) => space.id),
  });
  const built = await buildPlatformMcpTools({
    url: platformMcpUrl(ORIGIN, caller.orgId),
    headers: { Authorization: `Bearer ${token}`, "x-org-id": caller.orgId },
    organization,
    writeChunk: () => {},
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
    fetch: platformFetch,
  });
  let readFile: ReadFile | undefined;
  const pi = {
    registerTool: (tool: ReadFile) => {
      if (tool.name === "read_file") readFile = tool;
    },
  } as unknown as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  return {
    built,
    read: (uri: string) => readFile!.execute("c1", { uri, space_id: personal }),
    personal,
  };
}

describe("the space of a file a chat call names", () => {
  it("is recorded after the platform served the read, never for one it refused", async () => {
    const touched: string[] = [];
    const { built, read, personal } = await readFileTool(touched);
    try {
      const refused = await read(await runOutput(colleague));
      expect(refused.content[0]!.text).toContain("not_found");
      expect(touched).toEqual([personal]);

      await read(await runOutput(caller));
      expect(touched).toEqual([personal, personal, colleague.defaultSpaceId]);
    } finally {
      await built.close();
    }
  });
});
