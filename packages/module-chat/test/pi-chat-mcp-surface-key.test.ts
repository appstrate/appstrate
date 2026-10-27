// SPDX-License-Identifier: Apache-2.0

/**
 * The invariant `mcp-surface-cache.ts` rests on, enforced against the REAL
 * platform MCP server: what the chat's handshake learns — the server
 * `instructions` and every tool descriptor — is a function of
 * `platformMcpSurfaceKey` alone. Callers that differ in everything else (org,
 * user, org role, space, injected skills, a role preview) but carry the same
 * permission list get byte-identical answers, so one caller's cached surface is
 * exactly what the server would have told the next.
 *
 * If the server ever starts writing per-request content (an id, a space name,
 * the injected skills) into a descriptor or the instructions, the equality
 * below fails, and the key has to grow before the cache may serve it. The
 * control at the end proves the comparison can fail at all.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import type { InjectedSkills } from "@appstrate/core/chat-contract";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedSpace } from "../../../apps/api/test/helpers/seed.ts";
import { registerTestPlatformApp } from "../../../apps/api/test/helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { platformMcpSurfaceKey } from "../src/pi-chat/mcp-surface-cache.ts";
import { turnPermissions } from "../src/turn-permissions.ts";

const app = getTestApp();
await registerTestPlatformApp();

const ORIGIN = "http://localhost";
const platformFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  app.request(input instanceof URL ? input.toString() : input, init)) as typeof fetch;

interface Caller {
  ctx: TestContext;
  orgRole: "owner" | "member";
  spaceId: string;
  viewAs?: unknown;
  injectedSkills?: InjectedSkills;
}

/** One chat turn's handshake against the real server, uncached: key + what it learned. */
async function handshake(caller: Caller, permissions: readonly string[]) {
  const url = platformMcpUrl(ORIGIN, caller.ctx.orgId, caller.spaceId);
  const token = mintMcpLoopbackToken({
    userId: caller.ctx.user.id,
    email: caller.ctx.user.email,
    name: caller.ctx.user.name,
    orgId: caller.ctx.orgId,
    orgRole: caller.orgRole,
    permissions,
    ...(caller.viewAs !== undefined ? { viewAs: caller.viewAs } : {}),
    ...(caller.injectedSkills ? { injectedSkills: caller.injectedSkills } : {}),
  });
  const built = await buildPlatformMcpTools({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-org-id": caller.ctx.orgId,
    },
    spaceId: caller.spaceId,
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
      key: platformMcpSurfaceKey(url, permissions),
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
  it("answers every caller with the same key byte-identically", async () => {
    const otherSpaceA = await seedSpace({ orgId: ownerA.orgId, name: "Elsewhere" });
    const callers: Caller[] = [
      { ctx: ownerA, orgRole: "owner", spaceId: ownerA.defaultSpaceId },
      // Another space of the same org, a skill injected into the turn.
      {
        ctx: ownerA,
        orgRole: "owner",
        spaceId: otherSpaceA.id,
        injectedSkills: {
          spaceId: otherSpaceA.id,
          skills: { "@purity/tone": { definition: "published", version: "1.0.0" } },
        },
      },
      // Another org, another user, another org role.
      { ctx: builderB, orgRole: "member", spaceId: builderB.defaultSpaceId },
      // The owner previewing the builder role.
      {
        ctx: ownerA,
        orgRole: "member",
        spaceId: ownerA.defaultSpaceId,
        viewAs: {
          orgId: ownerA.orgId,
          orgRole: "member",
          space: { spaceId: ownerA.defaultSpaceId, role: { kind: "preset", preset: "builder" } },
        },
      },
    ];

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

  it("answers a different permission list differently, under a different key", async () => {
    const caller: Caller = { ctx: ownerA, orgRole: "owner", spaceId: ownerA.defaultSpaceId };
    const withAuthoring = await handshake(caller, grant);
    const withoutAuthoring = await handshake(
      caller,
      turnPermissions(grant, { authoring: false, skillMode: "auto" }),
    );
    expect(withoutAuthoring.key).not.toBe(withAuthoring.key);
    expect(withoutAuthoring.instructions).not.toBe(withAuthoring.instructions);
  });
});
