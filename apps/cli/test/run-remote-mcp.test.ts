// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run` in local mode reaches the MCP server of an unauthenticated remote integration
 * itself: its tools are listed and callable as `{ns}__{tool}`, filtered by the agent's selection
 * and the manifest's `hidden_tools`; a server it cannot reach leaves the integration unavailable
 * and the run starts without it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  renderPlatformPrompt,
  UNAVAILABLE_INTEGRATION_REASONS,
  type Bundle,
} from "@appstrate/afps-runtime/bundle";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { forgetProtocolEras, legacyMcpHandler } from "@appstrate/mcp-transport/testing";
import { buildRemoteMcpExtensions } from "../src/commands/run/remote-mcp.ts";
import { cliPromptInputs } from "../src/commands/run.ts";

const DOCS = "@acme/docs";

const echoTool = (name: string): AppstrateToolDefinition => ({
  descriptor: {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  handler: async (args) => ({
    content: [{ type: "text", text: `${name}:${String(args.q)}` }],
  }),
});

let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: legacyMcpHandler({ tools: [echoTool("a"), echoTool("b"), echoTool("secret")] }),
  });
  serverUrl = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => forgetProtocolEras());

interface BundleOptions {
  url?: string;
  tools?: readonly string[] | "*";
  integration?: Record<string, unknown>;
}

function makeBundle(opts: BundleOptions = {}): Bundle {
  const root = "@scope/agent@1.0.0";
  const agent = {
    name: "@scope/agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    dependencies: { integrations: { [DOCS]: "^1.0.0" } },
    ...(opts.tools !== undefined
      ? { integrations_configuration: { [DOCS]: { tools: opts.tools } } }
      : {}),
  };
  const integration = {
    name: DOCS,
    version: "1.0.0",
    schema_version: "0.1",
    type: "integration",
    source: {
      kind: "remote",
      remote: { url: opts.url ?? serverUrl, transport: "streamable-http" },
    },
    default_tools: ["a", "b"],
    hidden_tools: ["secret"],
    ...opts.integration,
  };
  const pkg = (identity: string, manifest: Record<string, unknown>, files = new Map()) => [
    identity,
    { identity, manifest, files, integrity: "" },
  ];
  return {
    version: "1.0",
    root,
    integrity: "sha256-test",
    packages: new Map([
      pkg(root, agent, new Map([["prompt.md", new TextEncoder().encode("Do it.")]])),
      pkg(`${DOCS}@1.0.0`, integration),
    ] as never),
  } as unknown as Bundle;
}

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

async function wire(
  bundle: Bundle,
  options: Omit<Parameters<typeof buildRemoteMcpExtensions>[0], "bundle"> = {},
) {
  const extensions = await buildRemoteMcpExtensions({ bundle, ...options });
  const tools: RegisteredTool[] = [];
  for (const factory of extensions.factories) {
    factory({ registerTool: (t: RegisteredTool) => tools.push(t) } as never);
  }
  return { extensions, tools };
}

describe("run --local — unauthenticated remote MCP integrations", () => {
  it("lists the default tools as {ns}__{tool} and forwards a call to the server", async () => {
    const { extensions, tools } = await wire(makeBundle());
    try {
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a", "acme_docs__b"]);
      expect([...extensions.integrationIds]).toEqual([DOCS]);
      expect(extensions.unavailable).toEqual([]);
      const result = await tools[1]!.execute("call_1", { q: "hi" });
      expect(result.content).toEqual([{ type: "text", text: "b:hi" }]);
    } finally {
      await extensions.close();
    }
  });

  it("exposes only the tools the agent selects", async () => {
    const { extensions, tools } = await wire(makeBundle({ tools: ["a"] }));
    try {
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a"]);
    } finally {
      await extensions.close();
    }
  });

  it("withholds hidden_tools, under the wildcard too", async () => {
    const { extensions, tools } = await wire(
      makeBundle({ tools: "*", integration: { allow_undeclared_tools: true } }),
    );
    try {
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a", "acme_docs__b"]);
    } finally {
      await extensions.close();
    }
  });

  it("lists the integration in the prompt catalog once its tools are wired", async () => {
    const bundle = makeBundle();
    const { extensions } = await wire(bundle);
    try {
      const prompt = renderPlatformPrompt(
        cliPromptInputs(
          bundle,
          { runId: "run_test", input: {}, memories: [] },
          extensions.unavailable,
          extensions.integrationIds,
        ),
      );
      expect(prompt).toContain(DOCS);
      expect(prompt).not.toContain("## Unavailable Integrations");
    } finally {
      await extensions.close();
    }
  });

  it("starts without an unreachable server's integration and tells the agent", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const closedUrl = `http://127.0.0.1:${probe.port}/mcp`;
    probe.stop(true);
    const bundle = makeBundle({ url: closedUrl });
    const { extensions, tools } = await wire(bundle);
    expect(tools).toEqual([]);
    expect(extensions.integrationIds.size).toBe(0);
    expect(extensions.unavailable).toEqual([
      { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error },
    ]);
    const prompt = renderPlatformPrompt(
      cliPromptInputs(
        bundle,
        { runId: "run_test", input: {}, memories: [] },
        extensions.unavailable,
        extensions.integrationIds,
      ),
    );
    expect(prompt).toContain(`- **${DOCS}**: ${UNAVAILABLE_INTEGRATION_REASONS.resolve_error}`);
  });

  it("refuses a redirect to a blocked network range off the declared host", async () => {
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, { status: 307, headers: { Location: "http://169.254.169.254/mcp" } }),
    });
    try {
      const { extensions, tools } = await wire(
        makeBundle({ url: `http://127.0.0.1:${redirector.port}/mcp` }),
      );
      expect(tools).toEqual([]);
      expect(extensions.unavailable).toEqual([
        { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.remote_url_blocked },
      ]);
    } finally {
      redirector.stop(true);
    }
  });

  it("leaves authenticated remote integrations out", async () => {
    const { extensions, tools } = await wire(
      makeBundle({
        integration: {
          auths: {
            main: {
              type: "api_key",
              authorized_uris: ["https://mcp.example.com/**"],
              credentials: { schema: {} },
            },
          },
        },
      }),
    );
    expect(tools).toEqual([]);
    expect(extensions.unavailable).toEqual([]);
  });

  for (const url of ["https://{$variable.tenant}.example.com/mcp", "{$variable.base_url}/mcp"]) {
    it(`marks the templated server address ${url} unrenderable without connecting`, async () => {
      const { extensions } = await wire(makeBundle({ url }));
      expect(extensions.factories).toEqual([]);
      expect(extensions.unavailable).toEqual([
        { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.remote_url_unrenderable },
      ]);
    });
  }

  it("marks a server that never answers unavailable once the startup timeout fires", async () => {
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const bundle = makeBundle({ url: `http://127.0.0.1:${silent.port}/mcp` });
      const started = Date.now();
      const extensions = await buildRemoteMcpExtensions({ bundle, startupTimeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(extensions.factories).toEqual([]);
      expect(extensions.unavailable).toEqual([
        { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error },
      ]);
    } finally {
      silent.stop(true);
    }
  });
});

describe("run --local — integration bound to the runtime", () => {
  const runtimeBound = {
    source: {
      kind: "remote",
      remote: { url: "https://platform.appstrate.invalid/mcp", transport: "streamable-http" },
    },
    _meta: { "dev.appstrate/platform": {} },
  };
  let runServer: ReturnType<typeof Bun.serve>;
  let runServerUrl: string;
  const authorizations: Array<string | null> = [];

  beforeAll(() => {
    const handler = legacyMcpHandler({ tools: [echoTool("a"), echoTool("b")] });
    runServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        authorizations.push(req.headers.get("authorization"));
        if (req.headers.get("authorization") !== "Bearer session-token") {
          return new Response("unauthorized", { status: 401 });
        }
        return handler(req);
      },
    });
    runServerUrl = `http://127.0.0.1:${runServer.port}/api/runs/run_1/mcp`;
  });

  afterAll(() => {
    runServer.stop(true);
  });

  it("reaches the run's MCP server with the session headers, filtered by the selection", async () => {
    authorizations.length = 0;
    const { extensions, tools } = await wire(
      makeBundle({ tools: ["a"], integration: runtimeBound }),
      {
        runToolsMcp: {
          url: runServerUrl,
          headers: { Authorization: "Bearer session-token", "X-Space-Id": "spc_1" },
        },
      },
    );
    try {
      expect(extensions.unavailable).toEqual([]);
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a"]);
      const result = await tools[0]!.execute("call_1", { q: "hi" });
      expect(result.content[0]?.text).toBe("a:hi");
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every((value) => value === "Bearer session-token")).toBe(true);
    } finally {
      await extensions.close();
    }
  });

  it("leaves the integration unbound when the run reports to no instance", async () => {
    authorizations.length = 0;
    const { extensions, tools } = await wire(makeBundle({ integration: runtimeBound }));
    expect(tools).toEqual([]);
    expect(extensions.unavailable).toEqual([
      { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.unbound },
    ]);
    expect(authorizations).toEqual([]);
  });
});
