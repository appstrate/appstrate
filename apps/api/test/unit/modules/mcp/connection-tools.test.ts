// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `search_integration_tools` and `call_integration_tool`: when they are declared,
 * what each one reads and dispatches to the credential proxy, and what the model is handed back.
 * Dispatch and the manifest reader are injected, so the proxy's own answers (its guard, its access
 * rule, its refusals) are stubbed here and exercised for real in
 * `src/modules/mcp/test/integration/connection-tools.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { withImpliedPermissions } from "@appstrate/core/permissions";
import {
  FORWARDED_AUTH_HEADERS,
  type Dispatch,
  type McpToolContext,
  type McpToolEvent,
} from "../../../../src/modules/mcp/tools.ts";
import { internalDispatchHeader } from "../../../../src/lib/internal-dispatch.ts";
import { isValidSessionId } from "../../../../src/services/credential-proxy/session.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { noExtra, parseResult, toolsFor } from "./helpers.ts";

// The declaration gate reads the guard mounted on the listing's route.
await registerTestPlatformApp();

/** What declares both tools: the transport's two grants and the proxy's permission outside a run. */
const CALL_OWN = ["mcp:read", "mcp:invoke", "credential-proxy:call-own"];
const TARGET = "https://api.example.com/v1/items";
const INTEGRATION = "@acme/items";

type Respond = (req: Request) => Response | Promise<Response>;

/** An upstream response as the proxy relays it (RFC 9209 `received-status`). */
function relayed(
  body: string | Uint8Array<ArrayBuffer> | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(body, {
    status,
    headers: { ...init.headers, "Proxy-Status": `appstrate; received-status=${status}` },
  });
}

const relayedJson = (value: unknown, status = 200) =>
  relayed(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A response the proxy produced itself: an RFC 9457 problem. */
function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.appstrate.dev/errors/${code}`,
      title: "Refused",
      status,
      detail,
      instance: "urn:appstrate:request:req_1",
      code,
      request_id: "req_1",
      ...extra,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "Proxy-Status": "appstrate; error=http_request_denied",
      },
    },
  );
}

const CONNECTION_ID = "8a6f2f0e-1c1b-4c58-9a36-0d7b7a1f3c11";

/** A row of the listing route (`GET /api/credential-proxy/connections`). */
function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integration_package_id: INTEGRATION,
    connection_id: CONNECTION_ID,
    label: "acct-1",
    owned_by_actor: true,
    auth_key: "api",
    scopes_granted: [],
    authorized_uris: ["https://api.example.com/**"],
    allow_all_uris: false,
    needs_reconnection: false,
    call_permission_required: false,
    ...overrides,
  };
}

/** An integration manifest whose `authKeys` each expose `api_call`. */
function apiManifest(
  name: string,
  authKeys: string[] = ["api"],
  extra: Record<string, unknown> = {},
): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    type: "integration",
    display_name: "Acme Items",
    auths: Object.fromEntries(authKeys.map((key) => [key, { type: "api_key" }])),
    _meta: { "dev.appstrate/api": { auths: Object.fromEntries(authKeys.map((k) => [k, {}])) } },
    ...extra,
  } as unknown as IntegrationManifest;
}

interface Fixture {
  /** What the listing route answers. */
  listing?: () => Response;
  manifests?: Record<string, IntegrationManifest>;
}

const listingOf = (rows: Record<string, unknown>[]) => () =>
  Response.json({ object: "list", data: rows, hasMore: false });

function makeTools(
  permissions: string[],
  respond: Respond = () => relayedJson({ ok: true }),
  proxyAcceptsCredential = true,
  fixture: Fixture = {},
) {
  const calls: Request[] = [];
  const listings: Request[] = [];
  const manifestReads: string[] = [];
  const events: McpToolEvent[] = [];
  const listing = fixture.listing ?? listingOf([connectionRow()]);
  const manifests = fixture.manifests ?? { [INTEGRATION]: apiManifest(INTEGRATION) };
  const dispatch: Dispatch = async (req) => {
    if (new URL(req.url).pathname === "/api/credential-proxy/connections") {
      listings.push(req);
      return listing();
    }
    calls.push(req);
    return respond(req);
  };
  const ctx: McpToolContext = {
    origin: "https://test.local",
    authHeaders: new Headers({
      authorization: "Bearer tok",
      "x-org-id": "org_1",
      "x-space-id": "spc_1",
    }),
    permissions: new Set(permissions),
    ceiling: undefined,
    dispatch,
    observe: (event) => events.push(event),
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: "spc_1" },
    authorizeBundle: async () => {},
    placeRootAs: async () => null,
    requestId: "req_test",
    followRunLogs: () => () => {},
    readIntegrationManifest: async (packageId) => {
      manifestReads.push(packageId);
      return manifests[packageId] ?? null;
    },
  };
  const tools = toolsFor(ctx, proxyAcceptsCredential);
  const byName = new Map(tools.map((tool) => [tool.descriptor.name, tool]));
  return { byName, calls, listings, manifestReads, events };
}

/** The tool `@acme/items` exposes. */
const TOOL = "acme_items__api_call";

const get = (overrides: Record<string, unknown> = {}) => ({
  method: "GET",
  target: TARGET,
  ...overrides,
});

async function apiCall(
  args: Record<string, unknown>,
  respond?: Respond,
  extra: AppstrateRequestExtra = noExtra,
) {
  const made = makeTools(CALL_OWN, respond);
  const result = await made.byName
    .get("call_integration_tool")!
    .handler({ tool: TOOL, arguments: args }, extra);
  return { ...made, result, payload: parseResult(result) };
}

type Entry = Record<string, unknown> & { error?: Record<string, unknown> };
const entries = (payload: Record<string, unknown>) => payload.results as Entry[];

const BOTH = ["search_integration_tools", "call_integration_tool"];

describe("connection tools — declaration", () => {
  const names = (permissions: string[], proxyAcceptsCredential = true): string[] => [
    ...makeTools(permissions, undefined, proxyAcceptsCredential).byName.keys(),
  ];

  it("withholds both without `mcp:invoke`: a read-only connection calls nothing", () => {
    const declared = names(["mcp:read", "credential-proxy:call-own"]);
    for (const name of BOTH) expect(declared).not.toContain(name);
  });

  it("declares both under either permission of a call outside a run", () => {
    // `credential-proxy:call` implies `call-own`: the closed set of either declares the tools.
    for (const permission of ["credential-proxy:call-own", "credential-proxy:call"]) {
      const declared = names([...withImpliedPermissions(["mcp:read", "mcp:invoke", permission])]);
      for (const name of BOTH) expect(declared, permission).toContain(name);
    }
  });

  it("withholds both when the proxy would refuse the credential the request carries", () => {
    const declared = names(CALL_OWN, false);
    for (const name of BOTH) expect(declared).not.toContain(name);
    expect(declared).toContain("invoke_operation");
  });

  it("declares neither retired name", () => {
    const declared = names([...withImpliedPermissions([...CALL_OWN, "credential-proxy:call"])]);
    expect(declared).not.toContain("list_connections");
    expect(declared).not.toContain("api_call");
  });

  it("names run_and_wait only to a caller who is offered it", () => {
    const description = (permissions: string[], name: string) =>
      makeTools(permissions).byName.get(name)!.descriptor.description!;
    const runner = [...CALL_OWN, "agents:run", "runs:read"];
    for (const name of BOTH) {
      expect(description(runner, name)).toContain("run_and_wait");
      expect(description(CALL_OWN, name)).not.toContain("run_and_wait");
    }
  });
});

describe("search_integration_tools", () => {
  const search = async (args: Record<string, unknown>, fixture: Fixture = {}) => {
    const made = makeTools(CALL_OWN, undefined, true, fixture);
    const result = await made.byName.get("search_integration_tools")!.handler(args, noExtra);
    return { ...made, result, payload: parseResult(result) };
  };
  const toolNames = (payload: Record<string, unknown>) =>
    (payload.tools as Array<{ tool: string }>).map((tool) => tool.tool);

  it("with no argument, lists every tool with every field of the listing's rows", async () => {
    const { result, payload, listings, calls, events } = await search({});
    expect(result.isError).toBe(false);
    const { integration_package_id: _integration, ...connection } = connectionRow();
    expect(payload).toEqual({
      total: 1,
      tools: [
        {
          tool: TOOL,
          integration: INTEGRATION,
          description: expect.stringContaining("Acme Items."),
          connections: [connection],
        },
      ],
    });
    expect(calls).toHaveLength(0);
    const req = listings[0]!;
    expect(req.method).toBe("GET");
    expect(req.headers.get("authorization")).toBe("Bearer tok");
    expect(req.headers.get("x-space-id")).toBe("spc_1");
    const [marker, value] = internalDispatchHeader();
    expect(req.headers.get(marker)).toBe(value);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "search_integration_tools",
        outcome: "invoked",
        shownCount: 1,
      }),
    ]);
  });

  it("carries the top result's input schema when searched, by keyword or integration", async () => {
    for (const args of [{ query: "items" }, { integration: INTEGRATION }]) {
      const { payload } = await search(args);
      const best = payload.best_match as Record<string, unknown> & {
        input_schema: { properties: Record<string, unknown>; additionalProperties: boolean };
      };
      expect(best.tool).toBe(TOOL);
      expect(Object.keys(best.input_schema.properties).sort()).toEqual([
        "max_response_bytes",
        "requests",
        "session_id",
      ]);
      expect(best.input_schema.additionalProperties).toBe(false);
      expect(best.usage).toContain("`{ session_id, results }`");
    }
    expect((await search({ query: "nothing-matches" })).payload).toEqual({ total: 0, tools: [] });
  });

  it("names one tool per auth when several expose api_call, each with its own connections", async () => {
    const { payload } = await search(
      {},
      {
        listing: listingOf([
          connectionRow({ connection_id: "c-oauth", auth_key: "oauth" }),
          connectionRow({ connection_id: "c-key", auth_key: "key" }),
        ]),
        manifests: { [INTEGRATION]: apiManifest(INTEGRATION, ["oauth", "key"]) },
      },
    );
    const tools = payload.tools as Array<{
      tool: string;
      connections: { connection_id: string }[];
    }>;
    expect(tools.map((t) => [t.tool, t.connections.map((c) => c.connection_id)])).toEqual([
      ["acme_items__api_call__oauth", ["c-oauth"]],
      ["acme_items__api_call__key", ["c-key"]],
    ]);
  });

  it("suffixes the namespace of a second package with the same slug", async () => {
    const { payload } = await search(
      {},
      {
        listing: listingOf([
          connectionRow({ integration_package_id: "@acme/items" }),
          connectionRow({ integration_package_id: "@acme-items/x", connection_id: "c-2" }),
          connectionRow({ integration_package_id: "@acme_items/x", connection_id: "c-3" }),
        ]),
        manifests: {
          "@acme/items": apiManifest("@acme/items"),
          "@acme-items/x": apiManifest("@acme-items/x"),
          "@acme_items/x": apiManifest("@acme_items/x"),
        },
      },
    );
    // `@acme-items/x` and `@acme_items/x` both normalise to `acme_items_x`; package ids sort first.
    expect(toolNames(payload)).toEqual([
      "acme_items_x__api_call",
      "acme_items__api_call",
      "acme_items_x_2__api_call",
    ]);
  });

  it("allocates namespaces over every listed integration, its manifest read or not", async () => {
    const { payload } = await search(
      {},
      {
        listing: listingOf([
          connectionRow({ integration_package_id: "@acme-items/x" }),
          connectionRow({ integration_package_id: "@acme_items/x", connection_id: "c-2" }),
        ]),
        manifests: { "@acme_items/x": apiManifest("@acme_items/x") },
      },
    );
    expect(toolNames(payload)).toEqual(["acme_items_x_2__api_call"]);
  });

  it("lists no hidden api_call, no auth without a connection, no unreadable manifest", async () => {
    const { payload } = await search(
      {},
      {
        listing: listingOf([
          connectionRow({ integration_package_id: "@acme/hidden" }),
          connectionRow({ integration_package_id: "@acme/gone" }),
          connectionRow({ integration_package_id: "@acme/plain", auth_key: "other" }),
        ]),
        manifests: {
          "@acme/hidden": apiManifest("@acme/hidden", ["api"], { hidden_tools: ["api_call"] }),
          "@acme/plain": apiManifest("@acme/plain"),
        },
      },
    );
    expect(payload).toEqual({ total: 0, tools: [] });
  });

  it("relays the listing route's refusal as `{ status, body }`", async () => {
    const { result, payload } = await search(
      {},
      { listing: () => problem(403, "forbidden", "Insufficient") },
    );
    expect(result.isError).toBe(true);
    expect(payload.status).toBe(403);
    expect((payload.body as { code: string }).code).toBe("forbidden");
  });
});

describe("call_integration_tool — tool", () => {
  const callWith = async (args: Record<string, unknown>, fixture: Fixture = {}) => {
    const made = makeTools(CALL_OWN, undefined, true, fixture);
    const result = await made.byName.get("call_integration_tool")!.handler(args, noExtra);
    return { ...made, result, payload: parseResult(result) };
  };

  it("requires `tool` and `arguments`", async () => {
    expect((await callWith({ arguments: {} })).payload).toMatchObject({
      code: "missing_argument",
      arguments: ["tool"],
    });
    expect((await callWith({ tool: TOOL })).payload).toMatchObject({
      code: "missing_argument",
      arguments: ["arguments"],
    });
  });

  it("refuses a tool the caller cannot call, retired names included", async () => {
    for (const tool of ["api_call", "list_connections", "acme_items__api_upload"]) {
      const { result, payload, calls } = await callWith({
        tool,
        arguments: { requests: [get()] },
      });
      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({ code: "unknown_tool", arguments: ["tool"] });
      expect(calls).toHaveLength(0);
    }
  });

  it("reads the manifest of the integration it calls, and no other", async () => {
    const { calls, manifestReads } = await callWith(
      { tool: "acme_other__api_call", arguments: { requests: [get()] } },
      {
        listing: listingOf([
          connectionRow(),
          connectionRow({ integration_package_id: "@acme/other", connection_id: "c-2" }),
        ]),
        manifests: {
          [INTEGRATION]: apiManifest(INTEGRATION),
          "@acme/other": apiManifest("@acme/other"),
        },
      },
    );
    expect(manifestReads).toEqual(["@acme/other"]);
    expect(calls[0]!.headers.get("X-Integration-Id")).toBe("@acme/other");
  });

  it("documents in its description only what holds for every tool", () => {
    const description =
      makeTools(CALL_OWN).byName.get("call_integration_tool")!.descriptor.description!;
    expect(description).toContain("input_schema");
    expect(description).not.toContain("session_id");
  });

  it("refuses a connection_id outside the tool's connections", async () => {
    const { payload, calls } = await callWith({
      tool: TOOL,
      arguments: { requests: [get({ connection_id: "not-mine" })] },
    });
    expect(payload).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[0].connection_id"],
    });
    expect(calls).toHaveLength(0);
  });

  it("pins an auth's tool to its own connections when the integration has others", async () => {
    const twoAuths: Fixture = {
      listing: listingOf([
        connectionRow({ connection_id: "c-oauth", auth_key: "oauth" }),
        connectionRow({ connection_id: "c-key-1", auth_key: "key" }),
        connectionRow({ connection_id: "c-key-2", auth_key: "key" }),
      ]),
      manifests: { [INTEGRATION]: apiManifest(INTEGRATION, ["oauth", "key"]) },
    };
    const single = await callWith(
      { tool: "acme_items__api_call__oauth", arguments: { requests: [get()] } },
      twoAuths,
    );
    expect(single.calls[0]!.headers.get("X-Connection-Id")).toBe("c-oauth");
    expect(single.calls[0]!.headers.get("X-Integration-Id")).toBe(INTEGRATION);

    const several = await callWith(
      { tool: "acme_items__api_call__key", arguments: { requests: [get()] } },
      twoAuths,
    );
    expect(several.payload).toMatchObject({
      code: "missing_argument",
      arguments: ["arguments.requests[0].connection_id"],
    });
    expect(several.calls).toHaveLength(0);
  });
});

describe("call_integration_tool — arguments", () => {
  const refused = async (args: Record<string, unknown>) => {
    const { result, payload, calls, events } = await apiCall(args);
    expect(result.isError).toBe(true);
    // Refused whole: nothing reaches the proxy, and a batch never runs in part.
    expect(calls).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ tool: "call_integration_tool", outcome: "rejected" }),
    ]);
    return payload;
  };

  it("requires `requests`, 1 to 50 of them", async () => {
    expect(await refused({})).toMatchObject({
      code: "missing_argument",
      arguments: ["arguments.requests"],
    });
    expect(await refused({ requests: [] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests"],
    });
    expect(await refused({ requests: Array.from({ length: 51 }, () => get()) })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests"],
    });
  });

  it("names the request and field at fault", async () => {
    expect(await refused({ requests: [get(), get({ method: "FETCH" })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[1].method"],
    });
    expect(await refused({ requests: [{ method: "GET" }] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[0].target"],
    });
    expect(await refused({ requests: [get({ body: 42 })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[0].body"],
    });
  });

  it("refuses a request field it does not declare instead of dropping it", async () => {
    // The sidecar's camelCase spelling: silently ignored, the body would go out unsubstituted.
    expect(await refused({ requests: [get({ substituteBody: true })] })).toMatchObject({
      code: "unknown_argument",
      arguments: ["arguments.requests[0].substituteBody"],
    });
  });

  it("refuses a body on GET", async () => {
    expect(await refused({ requests: [get({ body: { a: 1 } })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[0].body"],
    });
  });

  it("refuses a session id that is not a UUID v4, and an out-of-range cap", async () => {
    expect(await refused({ requests: [get()], session_id: "session-1" })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.session_id"],
    });
    expect(await refused({ requests: [get()], max_response_bytes: 262_145 })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.max_response_bytes"],
    });
  });

  it("lets no caller header set a proxy control or an auth-context header", async () => {
    const reserved = [
      // Every header the MCP router forwards as the caller's auth context, the space it
      // entered and the trusted re-entry marker: read off the lists the dispatch is built from.
      ...FORWARDED_AUTH_HEADERS,
      "x-space-id",
      internalDispatchHeader()[0],
      // The proxy's controls, each a typed argument or never sent, and the run a call names.
      "x-integration-id",
      "x-target",
      "x-session-id",
      "x-connection-id",
      "x-substitute-body",
      "x-stream-request",
      "x-stream-response",
      "x-max-response-size",
      "x-run-id",
      // The dispatched request's own framing and client source.
      "host",
      "content-length",
      "x-forwarded-for",
      "x-real-ip",
      // Case does not get one through.
      "Authorization",
      "X-Run-Id",
      "X-Stream-Response",
    ];
    for (const name of reserved) {
      const payload = await refused({
        requests: [get(), get({ headers: { Accept: "application/json", [name]: "forged" } })],
      });
      expect({ name, code: payload.code, arguments: payload.arguments }).toEqual({
        name,
        code: "invalid_argument",
        arguments: [`arguments.requests[1].headers.${name}`],
      });
    }
  });

  it("refuses a header or a target `Headers` cannot carry", async () => {
    expect(await refused({ requests: [get({ headers: { "X Bad": "v" } })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["arguments.requests[0].headers.X Bad"],
    });
    expect(
      await refused({ requests: [get({ target: `${TARGET}\r\nX-Run-Id: run_1` })] }),
    ).toMatchObject({ code: "invalid_argument", arguments: ["arguments.requests[0].target"] });
  });
});

describe("call_integration_tool — dispatch", () => {
  it("makes one proxy call per request, its control headers set from the typed arguments", async () => {
    const { calls, payload } = await apiCall({
      requests: [
        get({ headers: { Accept: "application/json" } }),
        get({
          method: "DELETE",
          target: `${TARGET}/7`,
          connection_id: "8a6f2f0e-1c1b-4c58-9a36-0d7b7a1f3c11",
        }),
      ],
      max_response_bytes: 1000,
    });

    expect(calls).toHaveLength(2);
    const [first, second] = calls as [Request, Request];
    for (const req of calls) {
      expect(new URL(req.url).pathname).toBe("/api/credential-proxy/proxy");
      expect(req.headers.get("X-Integration-Id")).toBe(INTEGRATION);
      expect(req.headers.get("X-Session-Id")).toBe(payload.session_id as string);
      expect(req.headers.has("X-Run-Id")).toBe(false);
      expect(req.headers.get("X-Max-Response-Size")).toBe("1000");
      // The caller's auth context and the trusted re-entry marker, as every dispatched tool.
      expect(req.headers.get("authorization")).toBe("Bearer tok");
      expect(req.headers.get("x-org-id")).toBe("org_1");
      expect(req.headers.get("x-space-id")).toBe("spc_1");
      const [marker, value] = internalDispatchHeader();
      expect(req.headers.get(marker)).toBe(value);
      // Never asked to stream: the buffered cap is what bounds the body read here.
      expect(req.headers.has("X-Stream-Response")).toBe(false);
      expect(req.headers.has("X-Substitute-Body")).toBe(false);
    }
    expect(first.method).toBe("GET");
    expect(first.headers.get("X-Target")).toBe(TARGET);
    expect(first.headers.get("Accept")).toBe("application/json");
    expect(first.headers.has("X-Connection-Id")).toBe(false);
    expect(second.method).toBe("DELETE");
    expect(second.headers.get("X-Target")).toBe(`${TARGET}/7`);
    expect(second.headers.get("X-Connection-Id")).toBe("8a6f2f0e-1c1b-4c58-9a36-0d7b7a1f3c11");
  });

  it("asks for the default cap unless told otherwise", async () => {
    const { calls } = await apiCall({ requests: [get()] });
    expect(calls[0]!.headers.get("X-Max-Response-Size")).toBe(String(32 * 1024));
  });

  it("sends an object body as JSON, a string body as written", async () => {
    const { calls } = await apiCall({
      requests: [
        get({ method: "POST", body: { name: "a", tags: ["x"] } }),
        get({
          method: "PUT",
          body: [1, 2],
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
        get({ method: "PATCH", body: "a=1&b={{token}}", substitute_body: true }),
      ],
    });
    const [object, array, text] = calls as [Request, Request, Request];

    expect(object.headers.get("content-type")).toBe("application/json");
    expect(await object.text()).toBe('{"name":"a","tags":["x"]}');
    // The caller's own Content-Type wins over the JSON default.
    expect(array.headers.get("content-type")).toBe("application/vnd.api+json");
    expect(await array.text()).toBe("[1,2]");
    // A string is not typed for the caller: no Content-Type appears.
    expect(text.headers.has("content-type")).toBe(false);
    expect(await text.text()).toBe("a=1&b={{token}}");
    expect(text.headers.get("X-Substitute-Body")).toBe("1");
  });

  it("generates the session a call runs in, and continues the one it is handed", async () => {
    const first = await apiCall({ requests: [get(), get()] });
    const sessionId = first.payload.session_id as string;
    expect(isValidSessionId(sessionId)).toBe(true);
    expect(first.calls.map((req) => req.headers.get("X-Session-Id"))).toEqual([
      sessionId,
      sessionId,
    ]);

    const fresh = await apiCall({ requests: [get()] });
    expect(fresh.payload.session_id).not.toBe(sessionId);

    const continued = await apiCall({ requests: [get()], session_id: sessionId });
    expect(continued.payload.session_id).toBe(sessionId);
    expect(continued.calls[0]!.headers.get("X-Session-Id")).toBe(sessionId);
  });

  it("keeps at most 3 requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await apiCall({ requests: Array.from({ length: 9 }, () => get()) }, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      return relayedJson({ ok: true });
    });
    expect(peak).toBe(3);
  });

  it("returns the entries in request order whatever order the answers arrive in", async () => {
    const { payload } = await apiCall(
      { requests: [0, 1, 2, 3].map((n) => get({ target: `${TARGET}/${n}` })) },
      async (req) => {
        const n = Number(req.headers.get("X-Target")!.split("/").pop());
        await Bun.sleep((4 - n) * 4);
        return relayedJson({ n });
      },
    );
    expect(entries(payload).map((entry) => [entry.index, entry.body])).toEqual([
      [0, { n: 0 }],
      [1, { n: 1 }],
      [2, { n: 2 }],
      [3, { n: 3 }],
    ]);
  });

  it("stops sending once the request is aborted", async () => {
    const controller = new AbortController();
    const made = makeTools(CALL_OWN, async () => {
      await Bun.sleep(1);
      controller.abort(new Error("client went away"));
      return relayedJson({ ok: true });
    });
    const call = made.byName
      .get("call_integration_tool")!
      .handler({ tool: TOOL, arguments: { requests: Array.from({ length: 10 }, () => get()) } }, {
        signal: controller.signal,
      } as unknown as AppstrateRequestExtra);
    await expect(call).rejects.toThrow("client went away");
    // The three already in flight, and none of the seven behind them.
    expect(made.calls).toHaveLength(3);
  });
});

describe("call_integration_tool — result", () => {
  it("returns an upstream answer as status, allowlisted headers and parsed body", async () => {
    const { result, payload } = await apiCall({ requests: [get()] }, () =>
      relayed(JSON.stringify({ items: [1, 2] }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          link: '<https://api.example.com/v1/items?page=2>; rel="next"',
          etag: '"v3"',
          "set-cookie": "sid=secret",
          authorization: "Bearer leaked",
          "x-internal-trace": "abc",
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(payload);
    expect(entries(payload)).toEqual([
      {
        index: 0,
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: '"v3"',
          link: '<https://api.example.com/v1/items?page=2>; rel="next"',
        },
        body: { items: [1, 2] },
      },
    ]);
  });

  it("tells an upstream refusal from the proxy's own, and runs the rest of the batch", async () => {
    const candidates = [{ id: "c1", label: "work" }];
    const answers: Record<string, () => Response> = {
      ok: () => relayedJson({ ok: true }),
      // The upstream refusing the connection's credential: relayed, not the platform's 401.
      upstream401: () => relayedJson({ error: "invalid_token" }, 401),
      call_permission_required: () => problem(403, "call_permission_required", "Refused."),
      must_choose: () =>
        problem(409, "must_choose_connection", "Name one with the X-Connection-Id header.", {
          errors: [{ field: "integrations.x", candidate_connections: candidates }],
        }),
      rate_limited: () => problem(429, "rate_limited", "Too many requests.", { retry_after: 12 }),
    };
    const order = Object.keys(answers);
    const { result, payload, calls } = await apiCall(
      { requests: order.map((key) => get({ target: `${TARGET}/${key}` })) },
      (req) => answers[req.headers.get("X-Target")!.split("/").pop()!]!(),
    );

    expect(calls).toHaveLength(order.length);
    expect(result.isError).toBe(false);
    const [ok, upstream401, callPermissionRequired, mustChoose, rateLimited] = entries(payload);
    expect(ok).toMatchObject({ index: 0, status: 200, body: { ok: true } });
    expect(upstream401).toMatchObject({ index: 1, status: 401, body: { error: "invalid_token" } });
    expect(upstream401).not.toHaveProperty("error");
    expect(callPermissionRequired).toEqual({
      index: 2,
      error: {
        status: 403,
        code: "call_permission_required",
        detail: "Refused.",
        request_id: "req_1",
      },
    });
    expect(mustChoose!.error).toMatchObject({
      status: 409,
      code: "must_choose_connection",
      errors: [{ field: "integrations.x", candidate_connections: candidates }],
    });
    expect(rateLimited!.error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retry_after: 12,
    });
  });

  it("is an error only when no request got a successful answer", async () => {
    const allFailed = await apiCall({ requests: [get(), get({ target: `${TARGET}/x` })] }, (req) =>
      req.headers.get("X-Target") === TARGET
        ? problem(404, "credential_not_found", "None.")
        : relayedJson({ message: "Not Found" }, 404),
    );
    expect(allFailed.result.isError).toBe(true);
    expect(entries(allFailed.payload)).toHaveLength(2);
  });

  it("keeps the batch when one dispatch throws below the proxy", async () => {
    const { result, payload } = await apiCall(
      { requests: [get(), get({ target: `${TARGET}/boom` })] },
      (req) => {
        if (req.headers.get("X-Target") !== TARGET) throw new Error("socket hang up");
        return relayedJson({ ok: true });
      },
    );
    expect(result.isError).toBe(false);
    expect(entries(payload)[0]).toMatchObject({ status: 200 });
    expect(entries(payload)[1]!.error).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("flags a body the proxy cut at the cap, and leaves it unparsed", async () => {
    const { payload } = await apiCall({ requests: [get()], max_response_bytes: 8 }, () =>
      relayed('{"items"', {
        headers: { "content-type": "application/json", "X-Truncated": "true" },
      }),
    );
    expect(entries(payload)[0]).toMatchObject({ body: '{"items"', truncated: true });
  });

  it("replaces a non-text body by its type and size", async () => {
    const { payload } = await apiCall({ requests: [get()] }, () =>
      relayed(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff]), {
        headers: { "content-type": "application/pdf" },
      }),
    );
    const [entry] = entries(payload);
    expect(entry).toEqual({
      index: 0,
      status: 200,
      headers: { "content-type": "application/pdf" },
      note: "Non-text response body omitted.",
      bytes: 5,
    });
  });

  it("carries no body for an answer that has none", async () => {
    const { payload } = await apiCall({ requests: [get({ method: "DELETE" })] }, () =>
      relayed(null, { status: 204 }),
    );
    expect(entries(payload)[0]).toEqual({ index: 0, status: 204, headers: {} });
  });

  it("bounds the whole result: later bodies are cut once the budget is spent", async () => {
    const chunk = 100 * 1024;
    const { payload } = await apiCall(
      { requests: Array.from({ length: 4 }, () => get()), max_response_bytes: 262_144 },
      () => relayed("a".repeat(chunk), { headers: { "content-type": "text/plain" } }),
    );
    const sizes = entries(payload).map((entry) => [
      (entry.body as string).length,
      entry.truncated === true,
    ]);
    // 256 KiB in all: two whole bodies, 56 KiB of the third, none of the fourth.
    expect(sizes).toEqual([
      [chunk, false],
      [chunk, false],
      [256 * 1024 - 2 * chunk, true],
      [0, true],
    ]);
    expect(payload.note).toContain("smaller batch");
  });

  it("never returns half a character where a cut falls inside one", async () => {
    const { payload } = await apiCall(
      { requests: [get(), get({ target: `${TARGET}/accent` })], max_response_bytes: 262_144 },
      (req) =>
        relayed(req.headers.get("X-Target") === TARGET ? "a".repeat(256 * 1024 - 1) : "é", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    // One byte of budget left for a two-byte character.
    expect(entries(payload)[1]).toMatchObject({ body: "", truncated: true });
  });

  it("reports one event per call, counting its entries", async () => {
    const { events } = await apiCall({ requests: [get(), get()] });
    expect(events).toEqual([
      expect.objectContaining({ tool: "call_integration_tool", outcome: "invoked", shownCount: 2 }),
    ]);
  });
});

describe("typed tools of a remote MCP integration", () => {
  const REMOTE = "@acme/docs";
  const remoteManifest = {
    name: REMOTE,
    version: "1.0.0",
    type: "integration",
    display_name: "Acme Docs",
    source: { kind: "remote", remote: { url: "https://mcp.acme.example/mcp" } },
    auths: { api: { type: "api_key" } },
    tools_policy: { search: {} },
  } as unknown as IntegrationManifest;
  const fixture: Fixture = {
    listing: listingOf([connectionRow({ integration_package_id: REMOTE })]),
    manifests: { [REMOTE]: remoteManifest },
  };
  const searchTool = {
    name: "search",
    description: "Full-text search.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  };
  const remoteRoutes =
    (call: Respond, list: Respond = () => Response.json({ tools: [searchTool], listed: true })) =>
    (req: Request) =>
      new URL(req.url).pathname === "/api/credential-proxy/tools/list" ? list(req) : call(req);

  it("lists the server's tools under the integration's namespace, read with the proxy's selection", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(() => Response.json({})),
      true,
      fixture,
    );
    const result = await made.byName
      .get("search_integration_tools")!
      .handler({ integration: REMOTE }, noExtra);
    const payload = parseResult(result);
    expect(payload.tools).toEqual([
      expect.objectContaining({
        tool: "acme_docs__search",
        integration: REMOTE,
        description: "Acme Docs. Full-text search.",
      }),
    ]);
    expect((payload.best_match as { input_schema: unknown }).input_schema).toEqual(
      searchTool.input_schema,
    );
    const listed = made.calls[0]!;
    expect(new URL(listed.url).pathname).toBe("/api/credential-proxy/tools/list");
    expect(await listed.json()).toEqual({ integration_id: REMOTE });
  });

  it("lists with one of the caller's connections when several qualify and none is named", async () => {
    const lists: unknown[] = [];
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(
        () => Response.json({}),
        async (req) => {
          const body = (await req.json()) as { connection_id?: string };
          lists.push(body);
          return body.connection_id
            ? Response.json({ tools: [searchTool], listed: true })
            : problem(409, "must_choose_connection", "Several connections qualify.");
        },
      ),
      true,
      fixture,
    );
    const payload = parseResult(
      await made.byName.get("search_integration_tools")!.handler({}, noExtra),
    );
    expect(payload.tools).toEqual([expect.objectContaining({ tool: "acme_docs__search" })]);
    expect(lists).toEqual([
      { integration_id: REMOTE },
      { integration_id: REMOTE, connection_id: CONNECTION_ID },
    ]);
  });

  it("lists and calls with the connection_id the caller names", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(() => Response.json({ result: { content: [] } })),
      true,
      fixture,
    );
    await made.byName
      .get("call_integration_tool")!
      .handler(
        { tool: "acme_docs__search", arguments: { q: "x" }, connection_id: CONNECTION_ID },
        noExtra,
      );
    const bodies = await Promise.all(made.calls.map((req) => req.clone().json()));
    expect(bodies).toEqual([
      { integration_id: REMOTE, connection_id: CONNECTION_ID },
      {
        integration_id: REMOTE,
        connection_id: CONNECTION_ID,
        name: "search",
        arguments: { q: "x" },
      },
    ]);
  });

  it("relays the listing's refusal when the tool cannot be listed", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(
        () => Response.json({}),
        () => problem(404, "credential_not_found", "No connection is usable in this space."),
      ),
      true,
      fixture,
    );
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: { q: "x" } }, noExtra);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({ code: "credential_not_found" });
    expect(made.calls.some((req) => new URL(req.url).pathname.endsWith("/tools/call"))).toBe(false);
  });

  it("marks a tool whose server could not be listed", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(
        () => Response.json({}),
        () =>
          Response.json({
            tools: [{ name: "search", input_schema: { type: "object" } }],
            listed: false,
          }),
      ),
      true,
      fixture,
    );
    const payload = parseResult(
      await made.byName.get("search_integration_tools")!.handler({}, noExtra),
    );
    expect(payload.tools).toEqual([
      expect.objectContaining({ tool: "acme_docs__search", catalog_unreadable: true }),
    ]);
  });

  it("calls the tool through the proxy's tool route and relays the server's result", async () => {
    const upstream = { content: [{ type: "text" as const, text: "3 documents" }] };
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(() => Response.json({ result: upstream })),
      true,
      fixture,
    );
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: { q: "invoices" } }, noExtra);
    expect(result).toEqual(upstream);
    const call = made.calls.find((req) => new URL(req.url).pathname.endsWith("/tools/call"))!;
    expect(await call.json()).toEqual({
      integration_id: REMOTE,
      name: "search",
      arguments: { q: "invoices" },
    });
  });

  it("refuses a missing required argument before calling", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(() => Response.json({})),
      true,
      fixture,
    );
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: {} }, noExtra);
    expect(parseResult(result)).toMatchObject({ code: "missing_argument" });
    expect(made.calls.some((req) => new URL(req.url).pathname.endsWith("/tools/call"))).toBe(false);
  });

  it("relays the route's refusal as an error result", async () => {
    const made = makeTools(
      CALL_OWN,
      remoteRoutes(() => problem(502, "bad_gateway", "The MCP server failed.")),
      true,
      fixture,
    );
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: { q: "x" } }, noExtra);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({ code: "bad_gateway", status: 502 });
  });
});
