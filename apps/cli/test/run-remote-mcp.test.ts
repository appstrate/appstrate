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
import { verify } from "@appstrate/afps-runtime/events";
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

  it("allocates its namespace past the ones the run's api_call tools hold", async () => {
    // An api_call integration whose id normalises alike already holds `acme_docs`.
    const { extensions, tools } = await wire(makeBundle(), {
      takenToolNames: new Set(["acme_docs__api_call"]),
    });
    try {
      expect(tools.map((t) => t.name)).toEqual(["acme_docs_2__a", "acme_docs_2__b"]);
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

/** An agent declaring one unauthenticated remote integration per URL, in this order. */
function makeMultiBundle(urls: readonly string[]): Bundle {
  const base = makeBundle();
  const root = base.packages.get(base.root)!;
  const ids = urls.map((_, i) => `@acme/server${i}`);
  const packages = new Map<string, unknown>([
    [
      base.root,
      {
        ...root,
        manifest: {
          ...root.manifest,
          dependencies: { integrations: Object.fromEntries(ids.map((id) => [id, "^1.0.0"])) },
        },
      },
    ],
    ...ids.map((id, i): [string, unknown] => [
      `${id}@1.0.0`,
      {
        identity: `${id}@1.0.0`,
        manifest: {
          name: id,
          version: "1.0.0",
          schema_version: "0.1",
          type: "integration",
          source: { kind: "remote", remote: { url: urls[i], transport: "streamable-http" } },
          default_tools: ["a"],
        },
        files: new Map(),
        integrity: "",
      },
    ]),
  ]);
  return { ...base, packages } as unknown as Bundle;
}

describe("run --local — several remote integrations", () => {
  it("connects them concurrently and names their tools in declaration order", async () => {
    const handler = legacyMcpHandler({ tools: [echoTool("a")] });
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        await Bun.sleep(150);
        return handler(req);
      },
    });
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const bundle = makeMultiBundle([
        `http://127.0.0.1:${slow.port}/mcp`,
        `http://127.0.0.1:${silent.port}/mcp`,
        `http://127.0.0.1:${silent.port}/mcp`,
        serverUrl,
      ]);
      const started = Date.now();
      const { extensions, tools } = await wire(bundle, { startupTimeoutMs: 1_000 });
      try {
        // Two silent servers one after the other would take two startup timeouts.
        expect(Date.now() - started).toBeLessThan(1_900);
        expect(tools.map((t) => t.name)).toEqual(["acme_server0__a", "acme_server3__a"]);
        expect(extensions.unavailable.map((entry) => entry.id)).toEqual([
          "@acme/server1",
          "@acme/server2",
        ]);
      } finally {
        await extensions.close();
      }
    } finally {
      slow.stop(true);
      silent.stop(true);
    }
  });
});

describe("run --local — integration bound to the runtime", () => {
  const RUN_SECRET = "run-secret";
  const runtimeBound = {
    source: {
      kind: "remote",
      remote: { url: "https://platform.appstrate.invalid/mcp", transport: "streamable-http" },
    },
    _meta: { "dev.appstrate/platform": {} },
  };
  interface SeenRequest {
    method: string;
    msgId: string | null;
    authorization: string | null;
    verified: boolean;
  }
  let runServer: ReturnType<typeof Bun.serve>;
  let runServerUrl: string;
  const seen: SeenRequest[] = [];

  /** The run's MCP server: every request must carry a valid signature of its exact body. */
  beforeAll(() => {
    const handler = legacyMcpHandler({ tools: [echoTool("a"), echoTool("b")] });
    runServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = await req.clone().text();
        const msgId = req.headers.get("webhook-id");
        const verified =
          msgId !== null &&
          verify({
            msgId,
            timestampSec: Number(req.headers.get("webhook-timestamp")),
            body,
            secret: RUN_SECRET,
            signatureHeader: req.headers.get("webhook-signature") ?? "",
          }).ok;
        seen.push({
          method: req.method,
          msgId,
          authorization: req.headers.get("authorization"),
          verified,
        });
        if (!verified) return new Response("invalid signature", { status: 401 });
        return handler(req);
      },
    });
    runServerUrl = `http://127.0.0.1:${runServer.port}/api/runs/run_1/mcp`;
  });

  afterAll(() => {
    runServer.stop(true);
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it("signs every request to the run's MCP server with the run secret, filtered by the selection", async () => {
    const { extensions, tools } = await wire(
      makeBundle({ tools: ["a"], integration: runtimeBound }),
      { runToolsMcp: { url: runServerUrl, runSecret: RUN_SECRET } },
    );
    try {
      expect(extensions.unavailable).toEqual([]);
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a"]);
      const result = await tools[0]!.execute("call_1", { q: "hi" });
      expect(result.content[0]?.text).toBe("a:hi");
    } finally {
      await extensions.close();
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((request) => request.verified && request.authorization === null)).toBe(true);
    // The client's GET (its server-to-client stream) is signed over the empty body.
    expect(seen.map((request) => request.method)).toContain("GET");
    // A fresh message id per request.
    expect(new Set(seen.map((request) => request.msgId)).size).toBe(seen.length);
  });

  it("refuses the integration when the signature is made with another secret", async () => {
    const { extensions, tools } = await wire(makeBundle({ integration: runtimeBound }), {
      runToolsMcp: { url: runServerUrl, runSecret: "another-secret" },
    });
    expect(tools).toEqual([]);
    expect(extensions.unavailable).toEqual([
      { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error },
    ]);
  });

  it("sends no signature and no Authorization header to an integration not bound to the runtime", async () => {
    const plain = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push({
          method: req.method,
          msgId: req.headers.get("webhook-id"),
          authorization: req.headers.get("authorization"),
          verified: req.headers.has("webhook-signature"),
        });
        return legacyMcpHandler({ tools: [echoTool("a"), echoTool("b")] })(req);
      },
    });
    try {
      const { extensions, tools } = await wire(
        makeBundle({ url: `http://127.0.0.1:${plain.port}/mcp` }),
        { runToolsMcp: { url: runServerUrl, runSecret: RUN_SECRET } },
      );
      try {
        await tools[0]!.execute("call_1", { q: "hi" });
      } finally {
        await extensions.close();
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((r) => r.msgId === null && !r.verified && r.authorization === null)).toBe(
        true,
      );
    } finally {
      plain.stop(true);
    }
  });

  it("leaves the integration unbound when the run reports to no instance", async () => {
    const { extensions, tools } = await wire(makeBundle({ integration: runtimeBound }));
    expect(tools).toEqual([]);
    expect(extensions.unavailable).toEqual([
      { id: DOCS, reason: UNAVAILABLE_INTEGRATION_REASONS.unbound },
    ]);
    expect(seen).toEqual([]);
  });
});
