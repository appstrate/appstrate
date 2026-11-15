// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run` in local mode reaches the MCP server of an unauthenticated remote integration
 * itself: its tools are listed and callable as `{ns}__{tool}`, filtered by the agent's selection
 * and the manifest's `hidden_tools`; a server it cannot reach leaves the integration unavailable
 * and the run starts without it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderPlatformPrompt,
  UNAVAILABLE_INTEGRATION_REASONS,
  type Bundle,
} from "@appstrate/afps-runtime/bundle";
import { verify } from "@appstrate/afps-runtime/events";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { forgetProtocolEras, legacyMcpHandler } from "@appstrate/mcp-transport/testing";
import { buildApiCallExtensionFactory, integrationOf } from "@appstrate/runner-pi";
import { buildRemoteMcpExtensions } from "../src/commands/run/remote-mcp.ts";
import { buildIntegrationResolver } from "../src/commands/run/resolver.ts";
import {
  buildIntegrationTools,
  cliPromptInputs,
  unavailableIntegrationLines,
} from "../src/commands/run.ts";
import {
  apiCallToolName,
  readApiCallSurfaces,
  type IntegrationApiCallResolver,
} from "@appstrate/afps-runtime/resolvers";

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

type WireOptions = Parameters<typeof buildRemoteMcpExtensions>[0];

/** The options of a run, `bundle` aside, that no test here looks at. */
const runOptions = (bundle: Bundle, options: Partial<WireOptions> = {}): WireOptions => ({
  bundle,
  takenToolNames: new Set(),
  runId: "run_test",
  workspace: os.tmpdir(),
  emit: () => {},
  ...options,
});

async function wire(bundle: Bundle, options: Partial<WireOptions> = {}) {
  const extensions = await buildRemoteMcpExtensions(runOptions(bundle, options));
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

  it("registers each tool with its integration and its name on the server", async () => {
    // Taken names push the namespace to `_2`: the identity still names the package.
    const { extensions, tools } = await wire(makeBundle(), {
      takenToolNames: new Set(["acme_docs__api_call"]),
    });
    try {
      expect(tools.map((t) => [t.name, integrationOf(t)])).toEqual([
        ["acme_docs_2__a", { id: DOCS, tool: "a" }],
        ["acme_docs_2__b", { id: DOCS, tool: "b" }],
      ]);
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
      {
        id: DOCS,
        reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
        detail: expect.any(String),
      },
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
    expect(prompt).not.toContain(extensions.unavailable[0]!.detail!);
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
        {
          id: DOCS,
          reason: UNAVAILABLE_INTEGRATION_REASONS.remote_url_blocked,
          detail: expect.stringContaining("169.254.169.254"),
        },
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

  it("closes the connected clients when wiring their tools throws", async () => {
    // A stateful server keeps the client's GET stream open until the client closes.
    let streamOpened!: () => void;
    const opened = new Promise<void>((resolve) => (streamOpened = resolve));
    let streamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (streamClosed = resolve));
    const handler = legacyMcpHandler({ tools: [echoTool("a")], stateful: true });
    const stateful = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (req.method === "GET") {
          req.signal.addEventListener("abort", () => streamClosed());
          streamOpened();
        } else if ((await req.clone().text()).includes('"tools/list"')) {
          await opened;
        }
        return handler(req);
      },
    });
    // Every namespace `@acme/docs` can take is held: allocating one throws once connected.
    const takenToolNames = new Set([
      "acme_docs__api_call",
      ...Array.from({ length: 998 }, (_, i) => `acme_docs_${i + 2}__api_call`),
    ]);
    try {
      const bundle = makeBundle({ url: `http://127.0.0.1:${stateful.port}/mcp` });
      await expect(
        buildRemoteMcpExtensions(runOptions(bundle, { takenToolNames })),
      ).rejects.toThrow("exhausted MCP namespace suffixes");
      await closed;
    } finally {
      stateful.stop(true);
    }
  });

  it("marks a server that never answers unavailable once the startup timeout fires", async () => {
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const bundle = makeBundle({ url: `http://127.0.0.1:${silent.port}/mcp` });
      const started = Date.now();
      const extensions = await buildRemoteMcpExtensions(
        runOptions(bundle, { startupTimeoutMs: 200 }),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(extensions.factories).toEqual([]);
      expect(extensions.unavailable).toEqual([
        {
          id: DOCS,
          reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
          detail: expect.any(String),
        },
      ]);
    } finally {
      silent.stop(true);
    }
  });
});

describe("run --local --integrations none", () => {
  // The mode picks how credentials resolve; an unauthenticated integration needs none.
  it("still wires an unauthenticated remote integration", async () => {
    const bundle = makeBundle();
    const apiCall = await buildApiCallExtensionFactory({
      bundle,
      integrationResolver: buildIntegrationResolver("none", null),
      runId: "run_test",
      workspace: os.tmpdir(),
      emitEvent: () => {},
    });
    const { extensions, tools } = await wire(bundle, { takenToolNames: apiCall.toolNames });
    try {
      expect(apiCall.factories).toEqual([]);
      expect(tools.map((t) => t.name)).toEqual(["acme_docs__a", "acme_docs__b"]);
    } finally {
      await extensions.close();
    }
  });
});

describe("run --local — the runner's tool factories", () => {
  // `factories` is what the runtime-ready event counts as `extensions`.
  it("holds the api_call tools and the remote MCP tools together", async () => {
    const MAIL = "@acme/mail";
    const base = makeBundle();
    const root = base.packages.get(base.root)!;
    const packages = new Map<string, unknown>(base.packages);
    packages.set(base.root, {
      ...root,
      manifest: {
        ...root.manifest,
        dependencies: { integrations: { [DOCS]: "^1.0.0", [MAIL]: "^1.0.0" } },
        integrations_configuration: { [MAIL]: { tools: ["api_call"] } },
      },
    });
    packages.set(`${MAIL}@1.0.0`, {
      identity: `${MAIL}@1.0.0`,
      manifest: {
        name: MAIL,
        version: "1.0.0",
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { main: {} } } },
        auths: {
          main: {
            type: "api_key",
            authorized_uris: ["https://api.example.com/**"],
            credentials: { schema: {} },
            delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
          },
        },
      },
      files: new Map(),
      integrity: "",
    });
    const resolver: IntegrationApiCallResolver = {
      resolve: async (refs, bundle) =>
        readApiCallSurfaces(bundle, refs).map((meta) => ({
          name: apiCallToolName(meta),
          description: meta.name,
          parameters: { type: "object" },
          execute: async () => ({ content: [] }),
        })),
    };
    const tools = await buildIntegrationTools({
      ...runOptions({ ...base, packages } as unknown as Bundle),
      integrationResolver: resolver,
    });
    try {
      expect(tools.apiCall.factories).toHaveLength(1);
      expect(tools.remoteMcp.factories).toHaveLength(2);
      expect(tools.factories).toEqual([...tools.apiCall.factories, ...tools.remoteMcp.factories]);
    } finally {
      await tools.remoteMcp.close();
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
    // The silent servers hold their requests until two are held at once, which never happens if
    // the integrations connect in turn; the first server answers only after that.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    let maxHeld = 0;
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        held += 1;
        maxHeld = Math.max(maxHeld, held);
        if (held === 2) release();
        // A client that gave up frees its slot: connecting in turn never holds two.
        const gaveUp = new Promise<void>((resolve) =>
          req.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        await Promise.race([released, gaveUp]);
        held -= 1;
        return new Response(null, { status: 503 });
      },
    });
    const handler = legacyMcpHandler({ tools: [echoTool("a")] });
    const late = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        await released;
        return handler(req);
      },
    });
    try {
      const bundle = makeMultiBundle([
        `http://127.0.0.1:${late.port}/mcp`,
        `http://127.0.0.1:${silent.port}/mcp`,
        `http://127.0.0.1:${silent.port}/mcp`,
        serverUrl,
      ]);
      const { extensions, tools } = await wire(bundle, { startupTimeoutMs: 10_000 });
      try {
        expect(maxHeld).toBe(2);
        expect(tools.map((t) => t.name)).toEqual(["acme_server0__a", "acme_server3__a"]);
        expect(extensions.unavailable.map((entry) => entry.id)).toEqual([
          "@acme/server1",
          "@acme/server2",
        ]);
      } finally {
        await extensions.close();
      }
    } finally {
      late.stop(true);
      silent.stop(true);
    }
  }, 60_000);
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
    /** The JSON-RPC method of a POST. */
    rpcMethod?: string;
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
          ...(body ? { rpcMethod: (JSON.parse(body) as { method?: string }).method } : {}),
          msgId,
          authorization: req.headers.get("authorization"),
          verified,
        });
        // As the platform: any other verb is a 405, before any signature check.
        if (req.method !== "POST") return new Response(null, { status: 405 });
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
    const posts = seen.filter((request) => request.method === "POST");
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((request) => request.verified && request.authorization === null)).toBe(true);
    // A bodiless request (the client's GET stream) is sent no signature.
    expect(seen.filter((request) => request.method !== "POST").every((r) => r.msgId === null)).toBe(
      true,
    );
    // A fresh message id per request.
    expect(new Set(posts.map((request) => request.msgId)).size).toBe(posts.length);
    // The server is legacy by construction: no era probe spends a signed request.
    expect(posts.map((request) => request.rpcMethod)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });

  it("refuses the integration when the signature is made with another secret", async () => {
    const { extensions, tools } = await wire(makeBundle({ integration: runtimeBound }), {
      runToolsMcp: { url: runServerUrl, runSecret: "another-secret" },
    });
    expect(tools).toEqual([]);
    // The refusal reaches the person, not the agent.
    expect(extensions.unavailable).toEqual([
      {
        id: DOCS,
        reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
        detail: expect.stringContaining("invalid signature"),
      },
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
    const entry = {
      id: DOCS,
      reason: UNAVAILABLE_INTEGRATION_REASONS.unbound,
      detail: "the run reports to no instance",
    };
    expect(extensions.unavailable).toEqual([entry]);
    expect(seen).toEqual([]);
    // The person reads the true cause; the agent, the reason alone.
    expect(unavailableIntegrationLines(extensions.unavailable)).toBe(
      `warn: integration ${DOCS} unavailable: ${entry.reason}\n  the run reports to no instance\n`,
    );
  });

  // Another port of the declared host: allowed by the egress guard, another origin all the same.
  it("sends no signature past a redirect to another origin", async () => {
    const headers: string[][] = [];
    const elsewhere = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        headers.push([...req.headers.keys()].filter((name) => name.startsWith("webhook-")));
        return legacyMcpHandler({ tools: [echoTool("a")] })(req);
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${elsewhere.port}/mcp` },
        }),
    });
    try {
      const { extensions } = await wire(makeBundle({ integration: runtimeBound }), {
        runToolsMcp: { url: `http://127.0.0.1:${redirector.port}/mcp`, runSecret: RUN_SECRET },
      });
      await extensions.close();
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.flat()).toEqual([]);
    } finally {
      redirector.stop(true);
      elsewhere.stop(true);
    }
  });
});

describe("run --local — remote MCP tool results", () => {
  it("spills a resource its tool returns to the workspace and reports the call", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "remote-mcp-spill-"));
    const file: AppstrateToolDefinition = {
      descriptor: { name: "a", inputSchema: { type: "object" } },
      handler: async () => ({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///report.txt", mimeType: "text/plain", text: "report body" },
          },
        ],
      }),
    };
    const fileServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: legacyMcpHandler({ tools: [file] }),
    });
    const events: string[] = [];
    try {
      const { extensions, tools } = await wire(
        makeBundle({ url: `http://127.0.0.1:${fileServer.port}/mcp`, tools: ["a"] }),
        { workspace, emit: (event) => events.push(event.type) },
      );
      try {
        const result = await tools[0]!.execute("call_1", {});
        expect(result.content[0]?.text).toContain(
          "saved to workspace file resources/call_1-report.txt",
        );
        expect(await Bun.file(path.join(workspace, "resources/call_1-report.txt")).text()).toBe(
          "report body",
        );
        expect(events).toEqual([
          "integration_tool.called",
          "integration_tool.completed",
          "resource.spilled",
        ]);
      } finally {
        await extensions.close();
      }
    } finally {
      fileServer.stop(true);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
