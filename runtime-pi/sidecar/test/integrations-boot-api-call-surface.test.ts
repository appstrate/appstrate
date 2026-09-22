// SPDX-License-Identifier: Apache-2.0

/**
 * Composition coverage for the synthetic api_call/api_upload surface.
 *
 * These tests deliberately cross the complete sidecar boundary that the
 * catalog/definition unit tests stop before:
 *
 *   IntegrationSpawnSpec -> bootIntegrations -> createApiCallToolDefs
 *   -> in-process MCP client -> McpHost -> final advertised tool names.
 *
 * No integration subprocess is spawned (`sourceKind: "none"`), but the real
 * McpHost registration, allowlist, hidden_tools filter, and namespace
 * allocation all run.
 */

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { ApiCallToolDeps } from "../mcp.ts";
import { TokenBudget } from "../token-budget.ts";
import { bootIntegrations, hiddenToolsForNativeUpstream } from "../integrations-boot.ts";

const INTEGRATION_ID = "@appstrate/drive";

const unreachableFetch = (async () => {
  throw new Error("api_call handler must not execute in a surface test");
}) as unknown as typeof fetch;

const apiCallDeps: ApiCallToolDeps = {
  proxyDeps: {
    config: {
      runToken: "run-token",
      platformApiUrl: "http://platform.local",
    },
    cookieJar: new Map(),
    fetchFn: unreachableFetch,
    reportedAuthFailures: new Set(),
  },
  tokenBudget: new TokenBudget(),
};

function credentialsWire(authKeys: readonly string[]): Record<string, unknown> {
  return {
    auths: authKeys.map((authKey) => ({
      auth_key: authKey,
      auth_type: "api_key",
      fields: { token: `${authKey}-token` },
      authorized_uris: ["https://www.googleapis.com/**"],
    })),
    delivery_plans: Object.fromEntries(
      authKeys.map((authKey) => [
        authKey,
        {
          header_name: "Authorization",
          header_prefix: "Bearer ",
          value: `${authKey}-token`,
          allow_server_override: false,
        },
      ]),
    ),
    expires_at_epoch_ms: Object.fromEntries(authKeys.map((authKey) => [authKey, null])),
  };
}

function platformFetch(authKeys: readonly string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(`/internal/integration-credentials/${INTEGRATION_ID}`)) {
      return new Response(JSON.stringify(credentialsWire(authKeys)), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: `unexpected platform call: ${url}` }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

const CONN_A = { id: "conn-a", label: "work", accountId: "work@example.com" };
const CONN_B = { id: "conn-b", label: "perso", accountId: "perso@example.com" };

function serverlessSpec(
  apiCalls: NonNullable<IntegrationSpawnSpec["apiCalls"]>,
  hiddenTools?: readonly string[],
  namespace = "drive",
  connection: IntegrationSpawnSpec["connection"] = CONN_A,
): IntegrationSpawnSpec {
  return {
    integrationId: INTEGRATION_ID,
    namespace,
    connection,
    sourceKind: "none",
    manifest: { name: INTEGRATION_ID, version: "1.0.0" },
    apiCalls,
    spawnEnv: {},
    toolAllowlist: apiCalls.flatMap((call) => {
      const names = [call.toolName];
      if ((call.uploadProtocols?.length ?? 0) > 0) {
        names.push(call.toolName.replace(/^api_call/, "api_upload"));
      }
      return names;
    }),
    ...(hiddenTools ? { hiddenTools } : {}),
  };
}

async function boot(...specs: IntegrationSpawnSpec[]) {
  const previousAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = "process";
  try {
    return await bootIntegrations(
      specs,
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
        fetchFn: platformFetch(specs.flatMap((s) => (s.apiCalls ?? []).map((c) => c.authKey))),
      },
      apiCallDeps,
    );
  } finally {
    if (previousAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = previousAdapter;
  }
}

describe("bootIntegrations — synthetic api_call surface", () => {
  it("reserves selected synthetic names against a same-named native upstream", () => {
    const spec = serverlessSpec(
      [
        {
          authKey: "primary",
          toolName: "api_call",
          authorizedUris: ["https://www.googleapis.com/**"],
          uploadProtocols: ["google-resumable"],
        },
      ],
      ["native_hidden"],
    );
    expect(hiddenToolsForNativeUpstream(spec)).toEqual(["native_hidden", "api_call", "api_upload"]);
  });

  it("keeps every serverless multi-auth tool in one namespace with its full name", async () => {
    const result = await boot(
      serverlessSpec([
        {
          authKey: "primary",
          toolName: "api_call__primary",
          authorizedUris: ["https://www.googleapis.com/**"],
          uploadProtocols: ["google-resumable"],
        },
        {
          authKey: "backup",
          toolName: "api_call__backup",
          authorizedUris: ["https://www.googleapis.com/**"],
        },
      ]),
    );
    try {
      expect(result.failed).toEqual([]);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        "drive__api_call__primary",
        "drive__api_upload__primary",
        "drive__api_call__backup",
      ]);
    } finally {
      await result.shutdown();
    }
  });

  it("keeps a long-auth upload pair valid under a maximum-length namespace", async () => {
    const authKey = "authentication_key_that_is_valid_but_long";
    const token = "h0a0593260c3968fd8";
    const namespace = "n".repeat(20);
    const spec = serverlessSpec(
      [
        {
          authKey: "short",
          toolName: "api_call__short",
          authorizedUris: ["https://www.googleapis.com/**"],
        },
        {
          authKey,
          toolName: `api_call__${token}`,
          authorizedUris: ["https://www.googleapis.com/**"],
          uploadProtocols: ["google-resumable"],
        },
      ],
      undefined,
      namespace,
    );
    // Only the canonical bounded names are reserved. The raw
    // `api_call__{authKey}` / `api_upload__{authKey}` spellings used to be
    // hidden alongside them; that alias is gone, so a native upstream tool
    // carrying one is left alone.
    expect(hiddenToolsForNativeUpstream(spec)).toEqual([
      "api_call__short",
      `api_call__${token}`,
      `api_upload__${token}`,
    ]);
    const result = await boot(spec);
    try {
      expect(result.failed).toEqual([]);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        `${namespace}__api_call__short`,
        `${namespace}__api_call__${token}`,
        `${namespace}__api_upload__${token}`,
      ]);
    } finally {
      await result.shutdown();
    }
  });

  it("registers the pair under a digit-leading package scope", async () => {
    // `@1password/connect` is a valid AFPS package id (SLUG_PATTERN admits a
    // leading digit). The spawn resolver passes the raw id as the namespace,
    // so the trusted registration path must accept the normalised
    // `1password_connect` prefix instead of failing the whole integration.
    const result = await boot(
      serverlessSpec(
        [
          {
            authKey: "primary",
            toolName: "api_call",
            authorizedUris: ["https://www.googleapis.com/**"],
            uploadProtocols: ["google-resumable"],
          },
        ],
        undefined,
        "@1password/connect",
      ),
    );
    try {
      expect(result.failed).toEqual([]);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        "1password_connect__api_call",
        "1password_connect__api_upload",
      ]);
    } finally {
      await result.shutdown();
    }
  });

  it("applies hidden_tools to the trusted in-process upload companion", async () => {
    const result = await boot(
      serverlessSpec(
        [
          {
            authKey: "primary",
            toolName: "api_call",
            authorizedUris: ["https://www.googleapis.com/**"],
            uploadProtocols: ["google-resumable"],
          },
        ],
        ["api_upload"],
      ),
    );
    try {
      expect(result.failed).toEqual([]);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual(["drive__api_call"]);
    } finally {
      await result.shutdown();
    }
  });

  it("serves ONE api_call tool for two connections, selected by a required enum", async () => {
    const apiCalls = [
      {
        authKey: "primary",
        toolName: "api_call",
        authorizedUris: ["https://www.googleapis.com/**"],
      },
    ];
    const result = await boot(
      serverlessSpec(apiCalls, undefined, "drive", CONN_A),
      serverlessSpec(apiCalls, undefined, "drive", CONN_B),
    );
    try {
      expect(result.failed).toEqual([]);
      // One descriptor, not `drive_2__api_call` — the second connection is a
      // route on the first's name.
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual(["drive__api_call"]);
      const schema = result.tools[0]!.descriptor.inputSchema as {
        properties: Record<string, { enum?: string[]; description?: string }>;
        required: string[];
      };
      expect(schema.properties.connection!.enum).toEqual(["work", "perso"]);
      expect(schema.required).toContain("connection");
      expect(schema.properties.connection!.description).toContain("work → work@example.com");
      expect(schema.properties.connection!.description).toContain("perso → perso@example.com");
      // Both connections booted, and the report names each one.
      expect(result.spawned.map((entry) => entry.connectionLabel)).toEqual(["work", "perso"]);
      expect(result.spawned.map((entry) => entry.toolCount)).toEqual([1, 1]);
    } finally {
      await result.shutdown();
    }
  });

  it("CONTROL — one connection leaves the api_call schema untouched", async () => {
    const apiCalls = [
      {
        authKey: "primary",
        toolName: "api_call",
        authorizedUris: ["https://www.googleapis.com/**"],
      },
    ];
    const result = await boot(serverlessSpec(apiCalls, undefined, "drive", CONN_A));
    try {
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual(["drive__api_call"]);
      const schema = result.tools[0]!.descriptor.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties)).not.toContain("connection");
      expect(schema.required ?? []).not.toContain("connection");
      expect(result.spawned[0]!.connectionLabel).toBe("work");
    } finally {
      await result.shutdown();
    }
  });

  it("injects the selector on the api_upload companion too", async () => {
    // The upload tool executes agent-side but dispatches through its
    // `api_call` sibling, so it has to advertise the same selector.
    const apiCalls = [
      {
        authKey: "primary",
        toolName: "api_call",
        authorizedUris: ["https://www.googleapis.com/**"],
        uploadProtocols: ["google-resumable"],
      },
    ];
    const result = await boot(
      serverlessSpec(apiCalls, undefined, "drive", CONN_A),
      serverlessSpec(apiCalls, undefined, "drive", CONN_B),
    );
    try {
      expect(result.failed).toEqual([]);
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        "drive__api_call",
        "drive__api_upload",
      ]);
      for (const tool of result.tools) {
        const schema = tool.descriptor.inputSchema as {
          properties: Record<string, { enum?: string[] }>;
          required: string[];
        };
        expect(schema.properties.connection!.enum).toEqual(["work", "perso"]);
        expect(schema.required).toContain("connection");
      }
    } finally {
      await result.shutdown();
    }
  });

  it("keeps the multi-auth suffix orthogonal to the connection selector", async () => {
    const apiCalls = [
      {
        authKey: "primary",
        toolName: "api_call__primary",
        authorizedUris: ["https://www.googleapis.com/**"],
      },
      {
        authKey: "backup",
        toolName: "api_call__backup",
        authorizedUris: ["https://www.googleapis.com/**"],
      },
    ];
    const result = await boot(
      serverlessSpec(apiCalls, undefined, "drive", CONN_A),
      serverlessSpec(apiCalls, undefined, "drive", CONN_B),
    );
    try {
      expect(result.failed).toEqual([]);
      // auth × connection: the auth suffix still names the tool, the
      // connection is a parameter on each of them.
      expect(result.tools.map((tool) => tool.descriptor.name)).toEqual([
        "drive__api_call__primary",
        "drive__api_call__backup",
      ]);
      for (const tool of result.tools) {
        const schema = tool.descriptor.inputSchema as {
          properties: Record<string, { enum?: string[] }>;
        };
        expect(schema.properties.connection!.enum).toEqual(["work", "perso"]);
      }
    } finally {
      await result.shutdown();
    }
  });

  it("hides the dependent upload companion when api_call itself is hidden", async () => {
    const result = await boot(
      serverlessSpec(
        [
          {
            authKey: "primary",
            toolName: "api_call",
            authorizedUris: ["https://www.googleapis.com/**"],
            uploadProtocols: ["google-resumable"],
          },
        ],
        ["api_call"],
      ),
    );
    try {
      expect(result.tools).toEqual([]);
      // Hiding `api_call` takes its upload companion with it, which leaves the
      // integration with nothing callable — a boot-contract violation, so the
      // spec lands on `failed[]` and the run aborts (see
      // integrations-boot-zero-tools.test.ts).
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.integrationId).toBe(INTEGRATION_ID);
      expect(result.report.ok).toBe(false);
    } finally {
      await result.shutdown();
    }
  });
});
