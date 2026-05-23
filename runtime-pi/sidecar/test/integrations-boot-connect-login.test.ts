// SPDX-License-Identifier: Apache-2.0

/**
 * P2 — sidecar boot hook for `connect.tool` + `runAt: "run-start"`.
 *
 * `runConnectLoginHook` is the slice of `bootIntegrations` that, after an
 * integration's MCP client is registered, mints the session by running the
 * integration's `login` tool via `runConnectLogin`. We exercise it against a
 * real `McpHost` (with an in-process login MCP server) + a real
 * `IntegrationCredentialsSource` and assert:
 *
 *   - the login tool is invoked at boot and the captured session header
 *     becomes injectable on the source (so the MITM listener injects it on
 *     every subsequent upstream request);
 *   - the login tool is NOT exposed to the agent (excluded from the
 *     allowlist by the spawn resolver);
 *   - a failing login throws (the boot loop maps that onto `failed[]`).
 */

import { describe, it, expect } from "bun:test";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { runConnectLoginHook } from "../integrations-boot.ts";
import { McpHost } from "../mcp-host.ts";
import {
  createIntegrationCredentialsSource,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

const DELIVERY_HTTP = { headerName: "Cookie", valueFrom: "JSESSIONID" } as const;

function emptyWire(): IntegrationCredentialsWire {
  return { auths: [], deliveryPlans: {}, expiresAtEpochMs: {} };
}

function makeSource() {
  const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  return createIntegrationCredentialsSource({
    integrationId: "@orga/wajax",
    platformApiUrl: "http://api",
    runToken: "run-tok",
    initialPayload: emptyWire(),
    fetchFn,
  });
}

/** A login MCP server that returns a captured session as JSON outputs. */
function loginTool(session: string): AppstrateToolDefinition[] {
  return [
    {
      descriptor: {
        name: "login",
        description: "perform the login dance",
        inputSchema: { type: "object" },
      },
      handler: async () => ({
        content: [{ type: "text", text: JSON.stringify({ outputs: { JSESSIONID: session } }) }],
      }),
    },
    {
      descriptor: {
        name: "fetch_invoices",
        description: "an agent-facing tool",
        inputSchema: { type: "object" },
      },
      handler: async () => ({ content: [{ type: "text", text: "invoices" }] }),
    },
  ];
}

/**
 * A login MCP server whose `login` tool returns a different session on each
 * call (drives the re-login → fresh-session assertion). The `sessions` array
 * is consumed in order; the last value repeats once exhausted.
 */
function rotatingLoginTool(sessions: string[]): {
  tools: AppstrateToolDefinition[];
  loginCalls: () => number;
} {
  let i = 0;
  let calls = 0;
  return {
    loginCalls: () => calls,
    tools: [
      {
        descriptor: { name: "login", description: "login", inputSchema: { type: "object" } },
        handler: async () => {
          const session = sessions[Math.min(i, sessions.length - 1)]!;
          i += 1;
          calls += 1;
          return {
            content: [{ type: "text", text: JSON.stringify({ outputs: { JSESSIONID: session } }) }],
          };
        },
      },
    ],
  };
}

/** A login MCP server whose login tool always errors. */
function failingLoginTool(): AppstrateToolDefinition[] {
  return [
    {
      descriptor: { name: "login", description: "broken login", inputSchema: { type: "object" } },
      handler: async () => {
        throw new Error("login backend unavailable");
      },
    },
  ];
}

function spec(overrides?: Partial<IntegrationSpawnSpec>): IntegrationSpawnSpec {
  return {
    integrationId: "@orga/wajax",
    namespace: "@orga/wajax",
    manifest: {
      name: "@orga/wajax",
      version: "0.1.0",
      server: { type: "node", entryPoint: "main.js" },
    },
    spawnEnv: {},
    // The spawn resolver already stripped `login` from the allowlist.
    toolAllowlist: ["fetch_invoices"],
    connectLogin: {
      toolName: "login",
      produces: ["JSESSIONID"],
      authKey: "session",
      authType: "custom",
      authorizedUris: ["https://saas.example.com/**"],
      deliveryHttp: DELIVERY_HTTP,
      inputs: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    },
    ...overrides,
  };
}

describe("runConnectLoginHook", () => {
  it("mints the session at boot — header injectable, login tool hidden from the agent", async () => {
    const pair = await createInProcessPair(loginTool("sess-xyz"));
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const host = new McpHost();
    const source = makeSource();
    try {
      // Mirror the boot order: register the upstream with the agent-facing
      // allowlist (login excluded), THEN run the connect-login hook.
      const allocatedNs = await host.register({
        namespace: "@orga/wajax",
        client,
        allowedTools: ["fetch_invoices"],
      });

      // The agent only sees the selected tool — never `login`.
      const agentTools = host.buildTools().map((t) => t.descriptor.name);
      expect(agentTools.some((n) => n.endsWith("__login"))).toBe(false);
      expect(agentTools.some((n) => n.endsWith("__fetch_invoices"))).toBe(true);

      // No session header injectable before the hook runs.
      expect(source.deliveryPlans().session).toBeUndefined();

      await runConnectLoginHook(spec(), host, source, allocatedNs);

      // The captured session header now renders from the source — the MITM
      // listener will inject it on every subsequent upstream request.
      const plan = source.deliveryPlans().session;
      expect(plan).toBeDefined();
      expect(plan!.headerName).toBe("Cookie");
      expect(plan!.value).toBe("sess-xyz");

      // The substitution window is closed afterwards.
      expect(source.activeInputs()).toBeNull();
    } finally {
      await pair.close();
    }
  });

  it("throws (→ boot marks the integration failed) when the login tool errors", async () => {
    const pair = await createInProcessPair(failingLoginTool());
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const host = new McpHost();
    const source = makeSource();
    try {
      const allocatedNs = await host.register({
        namespace: "@orga/wajax",
        client,
        allowedTools: [],
      });
      await expect(runConnectLoginHook(spec(), host, source, allocatedNs)).rejects.toThrow();
      // No session installed on failure.
      expect(source.deliveryPlans().session).toBeUndefined();
      expect(source.activeInputs()).toBeNull();
    } finally {
      await pair.close();
    }
  });

  it("throws when no MITM source exists (CA bring-up failed)", async () => {
    const host = new McpHost();
    await expect(runConnectLoginHook(spec(), host, null, "@orga/wajax")).rejects.toThrow(
      /MITM credentials source/,
    );
  });

  it("registers a re-login handler that re-mints the session on a reauth status", async () => {
    const rotating = rotatingLoginTool(["sess-1", "sess-2"]);
    const pair = await createInProcessPair(rotating.tools);
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const host = new McpHost();
    const source = makeSource();
    try {
      const allocatedNs = await host.register({
        namespace: "@orga/wajax",
        client,
        allowedTools: [],
      });

      // Initial login → sess-1, and the handler is registered for [401].
      await runConnectLoginHook(spec(), host, source, allocatedNs);
      expect(source.deliveryPlans().session!.value).toBe("sess-1");
      expect(rotating.loginCalls()).toBe(1);
      expect(source.shouldReauth("session", 401)).toBe(true);
      expect(source.shouldReauth("session", 403)).toBe(false);

      // Simulate the listener's reauth path: refreshOnUnauthorized routes to
      // the registered re-login handler, which re-runs the login tool.
      const ok = await source.refreshOnUnauthorized("session");
      expect(ok).toBe(true);
      expect(rotating.loginCalls()).toBe(2);
      // The fresh session is now injectable — a retried request gets sess-2.
      expect(source.deliveryPlans().session!.value).toBe("sess-2");
    } finally {
      await pair.close();
    }
  });

  it("honours a manifest-declared reauthOn over the [401] default", async () => {
    const rotating = rotatingLoginTool(["sess-1", "sess-2"]);
    const pair = await createInProcessPair(rotating.tools);
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const host = new McpHost();
    const source = makeSource();
    try {
      const allocatedNs = await host.register({
        namespace: "@orga/wajax",
        client,
        allowedTools: [],
      });
      const s = spec();
      s.connectLogin!.reauthOn = [419];
      await runConnectLoginHook(s, host, source, allocatedNs);
      expect(source.shouldReauth("session", 419)).toBe(true);
      expect(source.shouldReauth("session", 401)).toBe(false);
    } finally {
      await pair.close();
    }
  });

  it("a failed re-login resolves false so the listener keeps the original response", async () => {
    // First login succeeds (boot), subsequent re-logins error → handler false.
    let calls = 0;
    const tools: AppstrateToolDefinition[] = [
      {
        descriptor: { name: "login", description: "login", inputSchema: { type: "object" } },
        handler: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ outputs: { JSESSIONID: "boot" } }) },
              ],
            };
          }
          throw new Error("login backend unavailable");
        },
      },
    ];
    const pair = await createInProcessPair(tools);
    const client = wrapClient(pair.client, { close: () => Promise.resolve() });
    const host = new McpHost();
    const source = makeSource();
    try {
      const allocatedNs = await host.register({
        namespace: "@orga/wajax",
        client,
        allowedTools: [],
      });
      await runConnectLoginHook(spec(), host, source, allocatedNs);
      expect(source.deliveryPlans().session!.value).toBe("boot");

      // Re-login fails → false, and the previously-captured session is left
      // untouched (the listener returns the original failed response).
      const ok = await source.refreshOnUnauthorized("session");
      expect(ok).toBe(false);
      expect(calls).toBe(2);
      expect(source.deliveryPlans().session!.value).toBe("boot");
    } finally {
      await pair.close();
    }
  });
});
