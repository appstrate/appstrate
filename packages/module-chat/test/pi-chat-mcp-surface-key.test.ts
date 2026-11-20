// SPDX-License-Identifier: Apache-2.0

/**
 * The invariant `mcp-surface-cache.ts` rests on, enforced against the REAL
 * platform MCP server: what the chat's handshake learns — the server
 * `instructions` and every tool descriptor — is a function of
 * `platformMcpSurfaceKey` alone. Callers that differ in everything else (user,
 * injected skills) but reach the same spaces with the same permission list get
 * byte-identical answers, so one caller's cached surface is exactly what the server
 * would have told the next.
 *
 * If the server ever starts writing per-request content (an id, the injected
 * skills) into a descriptor or the instructions beyond what the key names, the
 * equality below fails, and the key has to grow before the cache may serve it.
 * The controls prove the comparison can fail at all.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import type { ReachableSpaceGrant } from "@appstrate/core/module";
import type { InjectedSkills } from "@appstrate/core/chat-contract";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { platformMcpSurfaceKey } from "../src/pi-chat/mcp-surface-cache.ts";
import { turnPermissions } from "../src/turn-permissions.ts";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { seedSpace } from "../../../apps/api/test/helpers/seed.ts";
import { reachableSpace } from "./reachable-space.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ORIGIN = "http://localhost";
const platformFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  app.request(input instanceof URL ? input.toString() : input, init)) as typeof fetch;

interface Caller {
  ctx: TestContext;
  orgRole: "owner" | "member";
  /** The spaces the caller reaches, as the router's middleware reads them. */
  spaces: ReachableSpaceGrant[];
  viewAs?: unknown;
  injectedSkills?: InjectedSkills;
}

/** The caller's one space, with the permissions it holds there. */
const reachOf = (
  ctx: TestContext,
  role: string,
  permissions: readonly string[],
): ReachableSpaceGrant[] => [
  reachableSpace({
    id: ctx.defaultSpaceId,
    name: "Default",
    role,
    permissions: [...permissions],
    // The default space opens the credential proxy, as seeded.
    credentialProxyOpen: true,
    isDefault: true,
  }),
];

/** One chat turn's handshake against the real server, uncached: key + what it learned. */
async function handshake(caller: Caller, permissions: readonly string[]) {
  const url = platformMcpUrl(ORIGIN, caller.ctx.orgId);
  const token = mintMcpLoopbackToken({
    userId: caller.ctx.user.id,
    email: caller.ctx.user.email,
    name: caller.ctx.user.name,
    orgId: caller.ctx.orgId,
    orgRole: caller.orgRole,
    permissions,
    spaceIds: caller.spaces.map((space) => space.id),
    ...(caller.viewAs !== undefined ? { viewAs: caller.viewAs } : {}),
    ...(caller.injectedSkills ? { injectedSkills: caller.injectedSkills } : {}),
  });
  const built = await buildPlatformMcpTools({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-org-id": caller.ctx.orgId,
    },
    organization: inertTurnSpaces(caller.spaces),
    writeChunk: () => {},
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
    fetch: platformFetch,
  });
  try {
    const tools: unknown[] = [];
    const pi = {
      registerTool: (tool: { name: string; description: string; parameters: unknown }) =>
        tools.push([tool.name, tool.description, tool.parameters]),
    } as unknown as ExtensionAPI;
    for (const factory of built.extensionFactories) factory(pi);
    return {
      key: platformMcpSurfaceKey(url, permissions, caller.spaces),
      instructions: built.instructions ?? "",
      tools: JSON.stringify(tools),
    };
  } finally {
    await built.close();
  }
}

let ownerA: TestContext;
let builderB: TestContext;
/** A member holding the `builder` preset: the grant every caller below narrows to. */
let grant: string[];

beforeEach(async () => {
  await truncateAll();
  ownerA = await createTestContext();
  builderB = await memberContext(await createTestContext(), "member", "builder");
  grant = [...new Set([...orgPermissions("member"), ...presetPermissions("builder")])];
});

describe("platform MCP surface key purity", () => {
  it("answers callers with the same key byte-identically", async () => {
    const callers: Caller[] = [
      { ctx: ownerA, orgRole: "owner", spaces: reachOf(ownerA, "owner", grant) },
      // The same reach, a skill injected into the turn.
      {
        ctx: ownerA,
        orgRole: "owner",
        spaces: reachOf(ownerA, "owner", grant),
        injectedSkills: {
          skills: {
            "@purity/tone": {
              definition: "published",
              version: "1.0.0",
              spaceId: ownerA.defaultSpaceId,
            },
          },
        },
      },
    ];

    // Another member of the org holding the same reach: same role, same space, same set.
    const peer = await memberContext(ownerA, "owner");
    callers.push({ ctx: peer, orgRole: "owner", spaces: reachOf(ownerA, "owner", grant) });

    const [first, ...rest] = await Promise.all(callers.map((c) => handshake(c, grant)));
    // Not a vacuous comparison: the surface carries real content.
    expect(first!.instructions).toContain("## Operation index");
    expect(first!.tools).toContain("run_and_wait");
    for (const other of rest) {
      expect(other.key).toBe(first!.key);
      expect(other.instructions).toBe(first!.instructions);
      expect(other.tools).toBe(first!.tools);
    }
  });

  it("answers a role preview like the member it previews, under the same key", async () => {
    // The owner previewing a builder of the default space reaches what a real builder reaches.
    const builder = await memberContext(ownerA, "member", "builder");
    const callers: Caller[] = [
      { ctx: builder, orgRole: "member", spaces: reachOf(ownerA, "builder", grant) },
      {
        ctx: ownerA,
        orgRole: "owner",
        spaces: reachOf(ownerA, "builder", grant),
        viewAs: {
          orgId: ownerA.orgId,
          orgRole: "member",
          space: { spaceId: ownerA.defaultSpaceId, role: { kind: "preset", preset: "builder" } },
        },
      },
    ];
    const [real, previewed] = await Promise.all(callers.map((c) => handshake(c, grant)));
    expect(previewed!.key).toBe(real!.key);
    expect(previewed!.instructions).toBe(real!.instructions);
    expect(previewed!.tools).toBe(real!.tools);
  });

  it("answers a different permission list differently, under a different key", async () => {
    const caller: Caller = {
      ctx: ownerA,
      orgRole: "owner",
      spaces: reachOf(ownerA, "owner", grant),
    };
    const withAuthoring = await handshake(caller, grant);
    const withoutAuthoring = await handshake(
      caller,
      turnPermissions(grant, { authoring: false, skillMode: "auto" }),
    );
    expect(withoutAuthoring.key).not.toBe(withAuthoring.key);
    expect(withoutAuthoring.instructions).not.toBe(withAuthoring.instructions);
  });

  it("answers callers reaching other spaces differently, under a different key", async () => {
    const mine = await handshake(
      { ctx: ownerA, orgRole: "owner", spaces: reachOf(ownerA, "owner", grant) },
      grant,
    );
    const theirs = await handshake(
      { ctx: builderB, orgRole: "member", spaces: reachOf(builderB, "builder", grant) },
      grant,
    );
    expect(theirs.key).not.toBe(mine.key);
    // Every space-acting tool lists the spaces in its `space_id`.
    expect(theirs.tools).not.toBe(mine.tools);
  });

  it("offers the integration tools, and withholds them under a different key where the space closes the proxy", async () => {
    const open: Caller = { ctx: ownerA, orgRole: "owner", spaces: reachOf(ownerA, "owner", grant) };
    const closedSpace = await seedSpace({ orgId: ownerA.orgId, name: "Closed" });
    await db
      .update(spaces)
      .set({ credentialProxyOpen: false })
      .where(eq(spaces.id, closedSpace.id));
    const closed: Caller = {
      ctx: ownerA,
      orgRole: "owner",
      spaces: [
        reachableSpace({
          id: closedSpace.id,
          name: "Closed",
          role: "owner",
          permissions: [...grant],
        }),
      ],
    };
    const [opened, shut] = await Promise.all([handshake(open, grant), handshake(closed, grant)]);
    expect(opened.tools).toContain("call_integration_tool");
    expect(shut.tools).not.toContain("call_integration_tool");
    expect(shut.key).not.toBe(opened.key);
  });
});
