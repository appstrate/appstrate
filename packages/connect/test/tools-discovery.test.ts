// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `toolsDynamic` re-discovery + drift detection
 * (proposal §5.4.6).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  buildConnectedAuthsKey,
  clearToolsDiscoveryCache,
  diffToolsAgainstLock,
  discoverToolsForUser,
  invalidateToolsForIntegration,
  invalidateToolsForUser,
  toolsDiscoveryCacheSize,
  type Tool,
} from "../src/tools-discovery.ts";

const TOOL_A: Tool = {
  name: "send_message",
  description: "send",
  inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
};
const TOOL_B: Tool = {
  name: "list_threads",
  description: "list",
  inputSchema: { type: "object", properties: { folder: { type: "string" } } },
};
const TOOL_A_WIDENED: Tool = {
  name: "send_message",
  description: "send",
  // new required property — must be flagged as schemaChanged
  inputSchema: {
    type: "object",
    properties: { to: { type: "string" }, attachments: { type: "array" } },
    required: ["to", "attachments"],
  },
};

function makeClient(toolsByCall: ReadonlyArray<Tool[]>) {
  let i = 0;
  return {
    calls: 0,
    async listTools() {
      const idx = Math.min(i, toolsByCall.length - 1);
      i += 1;
      this.calls += 1;
      return { tools: toolsByCall[idx]! };
    },
  };
}

beforeEach(() => {
  clearToolsDiscoveryCache();
});

describe("discoverToolsForUser — cache", () => {
  it("calls listTools on miss and caches the result", async () => {
    const client = makeClient([[TOOL_A]]);
    const result = await discoverToolsForUser({
      integrationId: "int-1",
      userId: "u1",
      connectedAuthsKey: "primary",
      client,
    });
    expect(result.fromCache).toBe(false);
    expect(result.tools).toEqual([TOOL_A]);
    expect(client.calls).toBe(1);
    expect(toolsDiscoveryCacheSize()).toBe(1);

    const hit = await discoverToolsForUser({
      integrationId: "int-1",
      userId: "u1",
      connectedAuthsKey: "primary",
      client,
    });
    expect(hit.fromCache).toBe(true);
    expect(hit.tools).toEqual([TOOL_A]);
    expect(client.calls).toBe(1); // unchanged — served from cache
  });

  it("evicts after TTL", async () => {
    let nowMs = 1000;
    const client = makeClient([[TOOL_A], [TOOL_A, TOOL_B]]);
    const req = { integrationId: "i", userId: "u", connectedAuthsKey: "k", client };
    const first = await discoverToolsForUser(req, { now: () => nowMs, ttlMs: 100 });
    expect(first.fromCache).toBe(false);
    nowMs += 50;
    const stillHit = await discoverToolsForUser(req, { now: () => nowMs, ttlMs: 100 });
    expect(stillHit.fromCache).toBe(true);
    nowMs += 100; // expired
    const refreshed = await discoverToolsForUser(req, { now: () => nowMs, ttlMs: 100 });
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.tools).toEqual([TOOL_A, TOOL_B]);
    expect(client.calls).toBe(2);
  });

  it("skipCache forces a fresh listTools call", async () => {
    const client = makeClient([[TOOL_A], [TOOL_B]]);
    const req = { integrationId: "i", userId: "u", connectedAuthsKey: "k", client };
    await discoverToolsForUser(req);
    const forced = await discoverToolsForUser(req, { skipCache: true });
    expect(forced.fromCache).toBe(false);
    expect(forced.tools).toEqual([TOOL_B]);
    expect(client.calls).toBe(2);
  });

  it("different users with different auth sets get isolated cache entries", async () => {
    const c1 = makeClient([[TOOL_A]]);
    const c2 = makeClient([[TOOL_B]]);
    await discoverToolsForUser({
      integrationId: "i",
      userId: "alice",
      connectedAuthsKey: "primary",
      client: c1,
    });
    await discoverToolsForUser({
      integrationId: "i",
      userId: "alice",
      connectedAuthsKey: "primary,extra",
      client: c2,
    });
    expect(toolsDiscoveryCacheSize()).toBe(2);
  });
});

describe("invalidateToolsForUser / invalidateToolsForIntegration", () => {
  it("targeted invalidation removes only one entry", async () => {
    const c = makeClient([[TOOL_A], [TOOL_B], [TOOL_A]]);
    const a = { integrationId: "i", userId: "alice", connectedAuthsKey: "k", client: c };
    const b = { integrationId: "i", userId: "bob", connectedAuthsKey: "k", client: c };
    await discoverToolsForUser(a);
    await discoverToolsForUser(b);
    expect(toolsDiscoveryCacheSize()).toBe(2);
    invalidateToolsForUser(a);
    expect(toolsDiscoveryCacheSize()).toBe(1);
  });

  it("integration-wide invalidation wipes every user's entry for that integration only", async () => {
    const c = makeClient([[TOOL_A], [TOOL_A], [TOOL_A]]);
    await discoverToolsForUser({
      integrationId: "i1",
      userId: "u1",
      connectedAuthsKey: "k",
      client: c,
    });
    await discoverToolsForUser({
      integrationId: "i1",
      userId: "u2",
      connectedAuthsKey: "k",
      client: c,
    });
    await discoverToolsForUser({
      integrationId: "i2",
      userId: "u1",
      connectedAuthsKey: "k",
      client: c,
    });
    expect(toolsDiscoveryCacheSize()).toBe(3);
    invalidateToolsForIntegration("i1");
    expect(toolsDiscoveryCacheSize()).toBe(1);
  });
});

describe("diffToolsAgainstLock", () => {
  it("identical lists report no drift", () => {
    const d = diffToolsAgainstLock([TOOL_A, TOOL_B], [TOOL_B, TOOL_A]);
    expect(d.identical).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.schemaChanged).toEqual([]);
  });

  it("flags an added tool (re-consent gate)", () => {
    const d = diffToolsAgainstLock([TOOL_A, TOOL_B], [TOOL_A]);
    expect(d.added).toEqual(["list_threads"]);
    expect(d.removed).toEqual([]);
    expect(d.schemaChanged).toEqual([]);
  });

  it("flags a removed tool (silent retire)", () => {
    const d = diffToolsAgainstLock([TOOL_A], [TOOL_A, TOOL_B]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual(["list_threads"]);
  });

  it("flags a schemaChanged tool when inputSchema bytes differ", () => {
    const d = diffToolsAgainstLock([TOOL_A_WIDENED, TOOL_B], [TOOL_A, TOOL_B]);
    expect(d.schemaChanged).toEqual(["send_message"]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("key-ordering invariance — does not flag reordered keys as schemaChanged", () => {
    const reordered: Tool = {
      name: TOOL_A.name,
      description: TOOL_A.description,
      // Re-order keys + nested key order; same logical schema.
      inputSchema: { required: ["to"], properties: { to: { type: "string" } }, type: "object" },
    };
    const d = diffToolsAgainstLock([reordered], [TOOL_A]);
    expect(d.schemaChanged).toEqual([]);
    expect(d.identical).toBe(true);
  });
});

describe("buildConnectedAuthsKey", () => {
  it("dedupes + sorts so cache keys are stable across auth-order permutations", () => {
    expect(buildConnectedAuthsKey(["b", "a", "b"])).toBe("a,b");
    expect(buildConnectedAuthsKey([])).toBe("");
    expect(buildConnectedAuthsKey(["only"])).toBe("only");
  });
});
