// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `provider-bridge.ts` — the adapter that turns AFPS
 * `ProviderResolver` output (typed `*_call` tools) into Pi SDK extension
 * factories. Drives the full flow without instantiating PiRunner.
 */

import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";
import type {
  Bundle,
  ProviderRef,
  ProviderResolver,
  Tool as AfpsTool,
} from "@appstrate/afps-runtime/resolvers";
import {
  afpsToolToPiExtension,
  buildProviderExtensionFactories,
  readProviderRefs,
} from "../src/provider-bridge.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────

function makeBundle(providers: Record<string, string> | null = null): LoadedBundle {
  const manifest: Record<string, unknown> = { name: "test", version: "1.0.0" };
  if (providers) {
    manifest.dependencies = { providers };
  }
  const encoder = new TextEncoder();
  return {
    manifest,
    prompt: "test prompt",
    files: {
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
      "prompt.md": encoder.encode("test prompt"),
    },
    compressedSize: 0,
    decompressedSize: 0,
  } as LoadedBundle;
}

function makeFakePi(): {
  api: ExtensionAPI;
  tools: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }>;
} {
  const tools: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
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

// ─── afpsToolToPiExtension ─────────────────────────────────────────────

describe("afpsToolToPiExtension", () => {
  it("registers a Pi tool whose execute forwards to the AFPS tool", async () => {
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const calls: unknown[] = [];
    const afpsTool: AfpsTool = {
      name: "gmail_call",
      description: "Call Gmail",
      parameters: { type: "object", required: [], properties: {} },
      async execute(args, ctx) {
        calls.push({ args, ctx });
        ctx.emit({
          type: "provider.called",
          timestamp: Date.now(),
          runId: ctx.runId,
          providerId: "@appstrate/gmail",
          status: 200,
        } as unknown as Parameters<typeof ctx.emit>[0]);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const factory = afpsToolToPiExtension(afpsTool, "run_1", "/workspace", (e) => events.push(e));
    const { api, tools } = makeFakePi();
    factory(api);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("gmail_call");
    expect(tools[0]!.label).toBe("gmail_call");

    const result = (await tools[0]!.execute("tc_1", { method: "GET", target: "https://x/y" })) as {
      content: unknown[];
      details: unknown;
    };
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], details: undefined });
    expect(calls).toHaveLength(1);
    expect(
      (calls[0] as { ctx: { runId: string; toolCallId: string; workspace: string } }).ctx,
    ).toMatchObject({ runId: "run_1", toolCallId: "tc_1", workspace: "/workspace" });
    expect(events).toHaveLength(1);
    expect(events[0]!).toMatchObject({
      type: "provider.called",
      providerId: "@appstrate/gmail",
      status: 200,
    });
  });

  it("coerces AFPS resource content into text stubs (Pi has no resource variant)", async () => {
    const afpsTool: AfpsTool = {
      name: "test_call",
      description: "",
      parameters: { type: "object", required: [], properties: {} },
      async execute() {
        return {
          content: [
            { type: "text", text: "hello" },
            { type: "resource", uri: "file:///tmp/x.bin" },
          ],
        };
      },
    };
    const factory = afpsToolToPiExtension(afpsTool, "r", "/w", () => {});
    const { api, tools } = makeFakePi();
    factory(api);

    const result = (await tools[0]!.execute("tc", {})) as { content: unknown[] };
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "[resource file:///tmp/x.bin]" },
    ]);
  });

  it("forwards a caller-supplied AbortSignal into ctx.signal", async () => {
    let seenAborted = false;
    const afpsTool: AfpsTool = {
      name: "slow_call",
      description: "",
      parameters: { type: "object", required: [], properties: {} },
      async execute(_, ctx) {
        seenAborted = ctx.signal.aborted;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const factory = afpsToolToPiExtension(afpsTool, "r", "/w", () => {});
    const { api, tools } = makeFakePi();
    factory(api);

    const controller = new AbortController();
    controller.abort();
    await tools[0]!.execute("tc", {}, controller.signal);
    expect(seenAborted).toBe(true);
  });
});

// ─── buildProviderExtensionFactories ───────────────────────────────────

describe("buildProviderExtensionFactories", () => {
  it("returns [] for a bundle with no providers (no resolver call)", async () => {
    let called = false;
    const resolver: ProviderResolver = {
      resolve: async () => {
        called = true;
        return [];
      },
    };
    const factories = await buildProviderExtensionFactories({
      bundle: makeBundle(),
      providerResolver: resolver,
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });
    expect(factories).toEqual([]);
    expect(called).toBe(false);
  });

  it("resolves refs from the manifest and produces one factory per tool", async () => {
    const seen: { refs: ProviderRef[]; bundle: Bundle } = { refs: [], bundle: null as never };
    const resolver: ProviderResolver = {
      resolve: async (refs, bundle) => {
        seen.refs = refs;
        seen.bundle = bundle;
        return refs.map((ref) => ({
          name: `${ref.name.replace(/[^a-z]/gi, "_")}_call`,
          description: "",
          parameters: { type: "object", required: [], properties: {} },
          async execute() {
            return { content: [{ type: "text", text: ref.name }] };
          },
        }));
      },
    };

    const factories = await buildProviderExtensionFactories({
      bundle: makeBundle({ "@appstrate/gmail": "1.0.0", "@appstrate/clickup": "^2.0.0" }),
      providerResolver: resolver,
      runId: "r",
      workspace: "/w",
      emitProvider: () => {},
    });

    expect(factories).toHaveLength(2);
    expect(seen.refs).toEqual([
      { name: "@appstrate/gmail", version: "1.0.0" },
      { name: "@appstrate/clickup", version: "^2.0.0" },
    ]);
    // bundle adapter surface must expose the minimal Bundle shape
    expect(typeof seen.bundle.read).toBe("function");
    expect(typeof seen.bundle.readText).toBe("function");
    expect(typeof seen.bundle.exists).toBe("function");

    const { api, tools } = makeFakePi();
    for (const f of factories) f(api);
    expect(tools.map((t) => t.name)).toEqual(["_appstrate_gmail_call", "_appstrate_clickup_call"]);
  });

  it("surfaces resolver errors to the caller", async () => {
    const resolver: ProviderResolver = {
      resolve: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      buildProviderExtensionFactories({
        bundle: makeBundle({ "@appstrate/gmail": "1.0.0" }),
        providerResolver: resolver,
        runId: "r",
        workspace: "/w",
        emitProvider: () => {},
      }),
    ).rejects.toThrow("boom");
  });
});
