// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `provider-bridge.ts` — the adapter that turns AFPS
 * `ProviderResolver` output into a single Pi SDK `provider_call`
 * extension factory.
 */

import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  Bundle,
  ProviderRef,
  ProviderResolver,
  Tool as AfpsTool,
} from "@appstrate/afps-runtime/resolvers";
import { buildProviderCallExtensionFactory, readProviderRefs } from "../src/provider-bridge.ts";
import { makeBundlePackage, makeTestBundle } from "./helpers.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────

function makeBundle(providers: Record<string, string> | null = null): Bundle {
  const extra: Record<string, unknown> = {};
  if (providers) extra.dependencies = { providers };
  return makeTestBundle(makeBundlePackage("@acme/agent", "1.0.0", "agent", {}, extra));
}

interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: unknown[]; isError?: boolean }>;
}

function makeFakePi(): { api: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

function makeAfpsTool(name: string, handler: (params: unknown) => Promise<unknown>): AfpsTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" },
    async execute(params: unknown) {
      const out = await handler(params);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  } as unknown as AfpsTool;
}

function makeResolver(refsToTools: Record<string, AfpsTool>): ProviderResolver {
  return {
    async resolve(refs: ProviderRef[]): Promise<AfpsTool[]> {
      return refs.map((r) => refsToTools[r.name]!).filter(Boolean);
    },
  };
}

// ─── readProviderRefs ──────────────────────────────────────────────────

describe("readProviderRefs", () => {
  it("returns [] when the bundle declares no providers", () => {
    expect(readProviderRefs(makeBundle())).toEqual([]);
  });

  it("returns [] when providers is an empty record", () => {
    expect(readProviderRefs(makeBundle({}))).toEqual([]);
  });

  it("maps each (name, version) entry to a ProviderRef", () => {
    const refs = readProviderRefs(
      makeBundle({ "@appstrate/gmail": "1.0.0", "@appstrate/clickup": "^2.0.0" }),
    );
    expect(refs).toEqual([
      { name: "@appstrate/gmail", version: "1.0.0" },
      { name: "@appstrate/clickup", version: "^2.0.0" },
    ]);
  });
});

// ─── buildProviderCallExtensionFactory ────────────────────────────────

describe("buildProviderCallExtensionFactory", () => {
  it("returns [] when the bundle declares no providers", async () => {
    const factories = await buildProviderCallExtensionFactory({
      bundle: makeBundle(),
      providerResolver: makeResolver({}),
      runId: "run_1",
      workspace: "/w",
      emitProvider: () => {},
    });
    expect(factories).toEqual([]);
  });

  it("registers a single `provider_call` Pi tool with providerId enum", async () => {
    const factories = await buildProviderCallExtensionFactory({
      bundle: makeBundle({ "@appstrate/gmail": "1", "@appstrate/clickup": "1" }),
      providerResolver: makeResolver({
        "@appstrate/gmail": makeAfpsTool("appstrate_gmail_call", async () => ({ ok: true })),
        "@appstrate/clickup": makeAfpsTool("appstrate_clickup_call", async () => ({ ok: true })),
      }),
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });
    expect(factories).toHaveLength(1);
    const { api, tools } = makeFakePi();
    factories[0]!(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("provider_call");
    const params = tools[0]!.parameters as { properties: { providerId: { enum: string[] } } };
    expect(params.properties.providerId.enum).toEqual(["@appstrate/gmail", "@appstrate/clickup"]);
  });

  it("dispatches by providerId, stripping it from the forwarded params", async () => {
    const seen: Array<{ tool: string; params: unknown }> = [];
    const factories = await buildProviderCallExtensionFactory({
      bundle: makeBundle({ "@appstrate/gmail": "1" }),
      providerResolver: makeResolver({
        "@appstrate/gmail": makeAfpsTool("appstrate_gmail_call", async (params) => {
          seen.push({ tool: "gmail", params });
          return { ok: true };
        }),
      }),
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });
    const { api, tools } = makeFakePi();
    factories[0]!(api);
    await tools[0]!.execute("call_1", {
      providerId: "@appstrate/gmail",
      method: "GET",
      target: "https://api.gmail.com/x",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.params).toEqual({ method: "GET", target: "https://api.gmail.com/x" });
  });

  it("returns isError when providerId is unknown — does not throw", async () => {
    const factories = await buildProviderCallExtensionFactory({
      bundle: makeBundle({ "@appstrate/gmail": "1" }),
      providerResolver: makeResolver({
        "@appstrate/gmail": makeAfpsTool("appstrate_gmail_call", async () => ({})),
      }),
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });
    const { api, tools } = makeFakePi();
    factories[0]!(api);
    const res = await tools[0]!.execute("c", { providerId: "@appstrate/unknown", target: "x" });
    expect(res.isError).toBe(true);
  });

  it("emits provider.called and provider.completed events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const factories = await buildProviderCallExtensionFactory({
      bundle: makeBundle({ "@appstrate/gmail": "1" }),
      providerResolver: makeResolver({
        "@appstrate/gmail": makeAfpsTool("appstrate_gmail_call", async () => ({})),
      }),
      runId: "r",
      workspace: "/w",
      emitProvider: (e) => events.push(e),
    });
    const { api, tools } = makeFakePi();
    factories[0]!(api);
    await tools[0]!.execute("call_1", {
      providerId: "@appstrate/gmail",
      target: "https://api.gmail.com/x",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("provider.called");
    expect(types).toContain("provider.completed");
  });
});
