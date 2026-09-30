// SPDX-License-Identifier: Apache-2.0

/**
 * `{ns}__api_call` Pi bridge (the CLI path): a tool-level
 * `isError` result is a Pi tool error reported as `api_call.completed`, while
 * an execution throw is reported as `api_call.failed`. Only the api_call tools
 * the agent's effective selection names are exposed — the platform's rule.
 */

import { describe, it, expect } from "bun:test";
import type { Tool as AfpsTool, ToolResult } from "@appstrate/afps-runtime/resolvers";
import { buildApiCallExtensionFactory } from "../src/api-call-bridge.ts";
import { makeBundlePackage, makeTestBundle } from "./helpers.ts";

const INTEGRATION = "@acme/api";

const integrationManifest = {
  schema_version: "0.1",
  type: "integration",
  source: { kind: "none" },
  _meta: { "dev.appstrate/api": { auths: { main: {} } } },
  auths: {
    main: {
      type: "api_key",
      authorized_uris: ["https://api.acme.com/**"],
      credentials: { schema: {} },
      delivery: {
        http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
      },
    },
  },
};

function bundleWith(
  config: Record<string, unknown> | undefined,
  manifest: Record<string, unknown> = integrationManifest,
) {
  const root = makeBundlePackage(
    "@acme/agent",
    "1.0.0",
    "agent",
    {},
    {
      dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
      ...(config ? { integrations_configuration: { [INTEGRATION]: config } } : {}),
    },
  );
  const integration = makeBundlePackage(INTEGRATION, "1.0.0", "integration" as "agent", {
    "integration.json": JSON.stringify(manifest),
  });
  return makeTestBundle(root, [integration]);
}

/** Names of the Pi tools the bridge registers for `bundle`, given one resolved tool per auth. */
async function registeredNames(bundle: ReturnType<typeof bundleWith>, resolved: string[]) {
  const factories = await buildApiCallExtensionFactory({
    bundle,
    integrationResolver: {
      resolve: async () =>
        resolved.map((name) => ({
          name,
          description: name,
          parameters: { type: "object" },
          execute: async () => ({ content: [] }),
        })),
    },
    runId: "run_test",
    workspace: "/tmp",
    emitEvent: () => {},
  });
  const names: string[] = [];
  for (const factory of factories) {
    factory({ registerTool: (t: { name: string }) => names.push(t.name) } as never);
  }
  return names;
}

async function registerApiCall(execute: AfpsTool["execute"]) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const tool: AfpsTool = {
    name: "acme__api_call",
    description: "acme api_call",
    parameters: { type: "object" },
    execute,
  };
  const [factory] = await buildApiCallExtensionFactory({
    bundle: bundleWith({ tools: ["api_call"] }),
    integrationResolver: { resolve: async () => [tool] },
    runId: "run_test",
    workspace: "/tmp",
    emitEvent: (event) => events.push(event),
  });
  const registered: Array<{ execute: (id: string, params: unknown) => Promise<unknown> }> = [];
  factory!({ registerTool: (t: never) => registered.push(t) } as never);
  return { execute: registered[0]!.execute, events };
}

describe("buildApiCallExtensionFactory", () => {
  it("throws an `isError` result as a Pi tool error, reported as completed", async () => {
    const { execute, events } = await registerApiCall(async (): Promise<ToolResult> => ({
      content: [{ type: "text", text: '{"status":404}' }],
      isError: true,
    }));

    await expect(execute("call-1", { target: "https://api.acme.com/x" })).rejects.toThrow(
      '{"status":404}',
    );
    expect(events.map((e) => e.type)).toEqual(["api_call.called", "api_call.completed"]);
    expect(events[1]).toMatchObject({ isError: true });
  });

  it("returns a successful result", async () => {
    const { execute, events } = await registerApiCall(async (): Promise<ToolResult> => ({
      content: [{ type: "text", text: "ok" }],
    }));

    expect(await execute("call-1", { target: "https://api.acme.com/x" })).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    });
    expect(events[1]).toMatchObject({ type: "api_call.completed", isError: false });
  });

  it("reports an execution throw as failed", async () => {
    const { execute, events } = await registerApiCall(async () => {
      throw new Error("socket closed");
    });

    await expect(execute("call-1", { target: "https://api.acme.com/x" })).rejects.toThrow(
      "socket closed",
    );
    expect(events.map((e) => e.type)).toEqual(["api_call.called", "api_call.failed"]);
  });

  it("exposes no api_call the agent did not select", async () => {
    expect(await registeredNames(bundleWith(undefined), ["acme__api_call"])).toEqual([]);
    expect(await registeredNames(bundleWith({ tools: [] }), ["acme__api_call"])).toEqual([]);
  });

  it("inherits the integration's default_tools when the agent selects nothing", async () => {
    const withDefault = { ...integrationManifest, default_tools: ["api_call"] };
    expect(await registeredNames(bundleWith(undefined, withDefault), ["acme__api_call"])).toEqual([
      "acme__api_call",
    ]);
  });

  it("keeps only the selected auth's tool on a multi-auth integration", async () => {
    const multi = {
      ...integrationManifest,
      _meta: { "dev.appstrate/api": { auths: { main: {}, backup: {} } } },
      auths: { main: integrationManifest.auths.main, backup: integrationManifest.auths.main },
    };
    expect(
      await registeredNames(bundleWith({ tools: ["api_call__backup"] }, multi), [
        "acme__api_call__main",
        "acme__api_call__backup",
      ]),
    ).toEqual(["acme__api_call__backup"]);
  });
});
