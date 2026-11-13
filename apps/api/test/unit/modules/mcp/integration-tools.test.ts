// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `search_integration_tools` and `call_integration_tool`: when they are declared,
 * what each one reads and dispatches to the credential proxy, and what the model is handed back.
 * Dispatch is injected, so the proxy's own answers (its listing of the tools, its guard, its
 * access rule, its refusals) are stubbed here; the listing is exercised for real in
 * `test/integration/routes/credential-proxy-tools.test.ts` and
 * `credential-proxy-remote-tools.test.ts`, the tools end to end in
 * `src/modules/mcp/test/integration/integration-tools.test.ts`.
 */

import { describe, it, expect } from "bun:test";
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
import { executeApiCall } from "../../../../src/modules/mcp/api-call-batch.ts";
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
/** The tool `@acme/items` exposes. */
const TOOL = "acme_items__api_call";

/** A connection of a listed tool, as `GET /api/credential-proxy/tools` gives it. */
function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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

/** A listed `api_call` tool. */
function apiCallTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "api_call",
    name: TOOL,
    integration_package_id: INTEGRATION,
    description: "Acme Items.",
    auth_key: "api",
    connection_required: false,
    connections: [connection()],
    ...overrides,
  };
}

interface Fixture {
  /** What the listing route (`GET /api/credential-proxy/tools`) answers. */
  listing?: (req: Request) => Response | Promise<Response>;
}

const listingOf =
  (
    tools: Record<string, unknown>[],
    rest: {
      not_ready?: Record<string, unknown>[];
      unlisted?: Record<string, unknown>[];
      truncated_catalogs?: Record<string, unknown>[];
    } = {},
  ) =>
  () =>
    Response.json({
      tools,
      not_ready: rest.not_ready ?? [],
      unlisted: rest.unlisted ?? [],
      truncated_catalogs: rest.truncated_catalogs ?? [],
    });

function makeTools(
  permissions: string[],
  respond: Respond = () => relayedJson({ ok: true }),
  proxyAcceptsCredential = true,
  fixture: Fixture = {},
) {
  const calls: Request[] = [];
  const listings: Request[] = [];
  const events: McpToolEvent[] = [];
  const listing = fixture.listing ?? listingOf([apiCallTool()]);
  const dispatch: Dispatch = async (req) => {
    if (new URL(req.url).pathname === "/api/credential-proxy/tools") {
      listings.push(req);
      return listing(req);
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
  };
  const tools = toolsFor(ctx, proxyAcceptsCredential);
  const byName = new Map(tools.map((tool) => [tool.descriptor.name, tool]));
  return { byName, calls, listings, events };
}

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

describe("integration tools — declaration", () => {
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

  it("with no argument, lists every tool with every field of the listing's connections", async () => {
    const { result, payload, listings, calls, events } = await search({});
    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      total: 1,
      tools: [
        {
          tool: TOOL,
          integration: INTEGRATION,
          description: expect.stringMatching(/^Acme Items\. Calls the integration's API/),
          connections: [connection()],
        },
      ],
    });
    expect(calls).toHaveLength(0);
    const req = listings[0]!;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).search).toBe("");
    expect(req.headers.get("authorization")).toBe("Bearer tok");
    expect(req.headers.get("x-space-id")).toBe("spc_1");
    // Asked for connect links, which `not_ready` hands to the human driving the client.
    expect(req.headers.get("x-appstrate-connect-offers")).toBe("1");
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

  it("asks the listing for the integration it searches, and ranks by keyword in listing order", async () => {
    const tools = [
      apiCallTool({ name: "acme_items__api_call__oauth", description: "Acme Items. Uses oauth." }),
      apiCallTool({
        name: "acme_crm__api_call",
        integration_package_id: "@acme/crm",
        description: "CRM.",
      }),
      apiCallTool({ name: "acme_items__api_call__key", description: "Acme Items. Uses key." }),
    ];
    const { listings, payload } = await search(
      { integration: INTEGRATION, query: "items key" },
      { listing: listingOf(tools) },
    );
    expect(new URL(listings[0]!.url).searchParams.get("integration_package_id")).toBe(INTEGRATION);
    expect(toolNames(payload)).toEqual([
      "acme_items__api_call__key",
      "acme_items__api_call__oauth",
    ]);
  });

  it("relays the listing route's refusal as `{ status, body }`", async () => {
    for (const code of ["forbidden", "credential_proxy_closed"]) {
      const { result, payload, events } = await search(
        {},
        { listing: () => problem(403, code, "Refused") },
      );
      expect(result.isError).toBe(true);
      expect(payload.status).toBe(403);
      expect((payload.body as { code: string }).code).toBe(code);
      expect(events).toEqual([
        expect.objectContaining({
          method: "GET",
          path: "/api/credential-proxy/tools",
          status: 403,
        }),
      ]);
    }
  });

  /** A `not_ready` entry of the listing. */
  const notReadyRow = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    integration_package_id: id,
    display_name: `${id} app`,
    proxy_connection: { status, imposed: false },
    ...extra,
  });

  it("lists the integrations without a usable connection in `not_ready`, apart from the tools", async () => {
    const refusal = {
      field: "integrations.@acme/mail",
      code: "not_connected",
      title: "Integration Not Connected",
      message: "Integration '@acme/mail' has no connection accessible to this actor",
      auth_key: "oauth",
      connect_url: "https://test.local/connect/start?token=t",
      expiresAt: "2026-11-13T16:00:00.000Z",
      packageId: "@acme/mail",
    };
    const { payload } = await search(
      {},
      {
        listing: listingOf([apiCallTool()], {
          not_ready: [
            notReadyRow("@acme/mail", "none", { refusal }),
            notReadyRow("@acme/crm", "needs_reconnection"),
          ],
        }),
      },
    );
    expect(toolNames(payload)).toEqual([TOOL]);
    expect(payload.not_ready).toEqual([
      {
        integration: "@acme/mail",
        display_name: "@acme/mail app",
        proxy_connection: { status: "none", imposed: false },
        refusal,
      },
      {
        integration: "@acme/crm",
        display_name: "@acme/crm app",
        proxy_connection: { status: "needs_reconnection", imposed: false },
      },
    ]);
  });

  it("filters `not_ready` by `query`", async () => {
    const listing = listingOf([], {
      not_ready: [notReadyRow("@acme/mail", "none"), notReadyRow("@acme/crm", "none")],
    });
    const shown = async (args: Record<string, unknown>) =>
      (
        (await search(args, { listing })).payload.not_ready as
          Array<{ integration: string }> | undefined
      )?.map((entry) => entry.integration);
    expect(await shown({ query: "mail" })).toEqual(["@acme/mail"]);
    expect(await shown({ query: "nothing-matches" })).toBeUndefined();
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

  it("resolves the tool by its full name through the listing, and calls its integration", async () => {
    const other = apiCallTool({
      name: "acme_other___api_call",
      integration_package_id: "@acme/other",
    });
    const { calls, listings } = await callWith(
      { tool: "acme_other___api_call", arguments: { requests: [get()] } },
      { listing: listingOf([apiCallTool(), other]) },
    );
    const query = new URL(listings[0]!.url).searchParams;
    expect([...query]).toEqual([["name", "acme_other___api_call"]]);
    expect(calls[0]!.headers.get("X-Integration-Id")).toBe("@acme/other");
  });

  it("documents in its description only what holds for every tool", () => {
    const description =
      makeTools(CALL_OWN).byName.get("call_integration_tool")!.descriptor.description!;
    expect(description).toContain("input_schema");
    expect(description).not.toContain("session_id");
  });

  it("refuses a connection_id outside the tool's connections", async () => {
    for (const connectionId of ["not-mine", "2b0d7c4e-5f6a-4b8c-9d1e-3f2a1b0c9d8e"]) {
      const { payload, calls } = await callWith({
        tool: TOOL,
        arguments: { requests: [get({ connection_id: connectionId })] },
      });
      expect(payload).toMatchObject({
        code: "invalid_argument",
        arguments: ["arguments.requests[0].connection_id"],
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("takes a connection_id in any case, and sends it as listed", async () => {
    const { calls } = await callWith({
      tool: TOOL,
      arguments: { requests: [get({ connection_id: CONNECTION_ID.toUpperCase() })] },
    });
    expect(calls[0]!.headers.get("X-Connection-Id")).toBe(CONNECTION_ID);
  });

  it("names a connection when the listing says the integration has others", async () => {
    const KEY_1 = "1f0e9d8c-7b6a-4c5d-8e4f-3a2b1c0d9e8f";
    const KEY_2 = "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d";
    const tools = [
      apiCallTool({ name: "acme_items__api_call__oauth", connection_required: true }),
      apiCallTool({
        name: "acme_items__api_call__key",
        auth_key: "key",
        connection_required: true,
        connections: [connection({ connection_id: KEY_1 }), connection({ connection_id: KEY_2 })],
      }),
    ];
    const single = await callWith(
      { tool: "acme_items__api_call__oauth", arguments: { requests: [get()] } },
      { listing: listingOf(tools) },
    );
    expect(single.calls[0]!.headers.get("X-Connection-Id")).toBe(CONNECTION_ID);
    expect(single.calls[0]!.headers.get("X-Integration-Id")).toBe(INTEGRATION);

    const several = await callWith(
      { tool: "acme_items__api_call__key", arguments: { requests: [get()] } },
      { listing: listingOf(tools) },
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

  it("marks a batch holding an upstream answer as third-party content, and one holding only the platform's refusals not", async () => {
    const connectUrl = "https://test.local/api/integrations/connect/start?t=one-use";
    const refusal = () =>
      problem(409, "needs_reconnection", "Reconnect it.", {
        errors: [{ field: `integrations.${INTEGRATION}`, connect_url: connectUrl }],
      });

    // An upstream's answer, even beside a refusal: its body is the upstream's own text.
    const mixed = await apiCall(
      { requests: [get(), get({ target: `${TARGET}/refused` })] },
      (req) => (req.headers.get("X-Target") === TARGET ? relayedJson({ ok: true }) : refusal()),
    );
    expect(mixed.result._meta).toEqual({ "dev.appstrate/third-party": true });

    // Only the platform's refusals: nothing third-party, so the connect link stays an offer.
    const refusalsOnly = await apiCall({ requests: [get(), get({ target: `${TARGET}/x` })] }, () =>
      refusal(),
    );
    expect(refusalsOnly.result.isError).toBe(true);
    expect(refusalsOnly.result._meta?.["dev.appstrate/third-party"]).toBeUndefined();
    expect(entries(refusalsOnly.payload)[0]!.error).toMatchObject({
      code: "needs_reconnection",
      errors: [{ connect_url: connectUrl }],
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
  const inputSchema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  };
  const remoteTool = (overrides: Record<string, unknown> = {}) => ({
    kind: "remote",
    name: "acme_docs__search",
    integration_package_id: REMOTE,
    description: "Acme Docs. Full-text search.",
    remote_name: "search",
    input_schema: inputSchema,
    connections: [connection({ missing_scopes: [] })],
    ...overrides,
  });
  const fixture: Fixture = { listing: listingOf([remoteTool()]) };
  const callTool = (paths: Request[]) =>
    paths.find((req) => new URL(req.url).pathname.endsWith("/tools/call"));

  it("lists a typed tool as the listing describes it, its schema in `best_match`", async () => {
    const made = makeTools(CALL_OWN, undefined, true, fixture);
    const payload = parseResult(
      await made.byName.get("search_integration_tools")!.handler({ integration: REMOTE }, noExtra),
    );
    expect(payload.tools).toEqual([
      {
        tool: "acme_docs__search",
        integration: REMOTE,
        description: "Acme Docs. Full-text search.",
        connections: [connection({ missing_scopes: [] })],
      },
    ]);
    const best = payload.best_match as { input_schema: unknown; usage: string };
    expect(best.input_schema).toEqual(inputSchema);
    expect(best.usage).toContain("the server's own tool result");
    expect(made.calls).toHaveLength(0);
  });

  it("marks a tool whose server could not be listed", async () => {
    const made = makeTools(CALL_OWN, undefined, true, {
      listing: listingOf([
        remoteTool({ catalog_unreadable: true, input_schema: { type: "object" } }),
      ]),
    });
    const payload = parseResult(
      await made.byName.get("search_integration_tools")!.handler({}, noExtra),
    );
    expect(payload.tools).toEqual([
      expect.objectContaining({ tool: "acme_docs__search", catalog_unreadable: true }),
    ]);
  });

  it("lists and calls with the connection_id the caller names", async () => {
    const made = makeTools(
      CALL_OWN,
      () => Response.json({ result: { content: [] } }),
      true,
      fixture,
    );
    await made.byName
      .get("call_integration_tool")!
      .handler(
        { tool: "acme_docs__search", arguments: { q: "x" }, connection_id: CONNECTION_ID },
        noExtra,
      );
    const query = new URL(made.listings[0]!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      name: "acme_docs__search",
      connection_id: CONNECTION_ID,
    });
    expect(await callTool(made.calls)!.json()).toEqual({
      integration_package_id: REMOTE,
      connection_id: CONNECTION_ID,
      name: "search",
      arguments: { q: "x" },
    });
  });

  it("relays the listing's refusal when the tool cannot be listed", async () => {
    const refusal = {
      type: "https://docs.appstrate.dev/errors/credential-not-found",
      title: "Credential Not Found",
      status: 404,
      detail: "No connection is usable in this space.",
      instance: "urn:appstrate:request:req_1",
      code: "credential_not_found",
      request_id: "req_1",
    };
    const made = makeTools(CALL_OWN, () => Response.json({}), true, {
      listing: listingOf([], { unlisted: [{ integration_package_id: REMOTE, refusal }] }),
    });
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: { q: "x" } }, noExtra);
    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual(refusal);
    expect(made.calls).toHaveLength(0);
  });

  it("calls the tool through the proxy's tool route by its server name and relays its result", async () => {
    const upstream = { content: [{ type: "text" as const, text: "3 documents" }] };
    const made = makeTools(CALL_OWN, () => Response.json({ result: upstream }), true, fixture);
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: { q: "invoices" } }, noExtra);
    // Relayed as the server answered, marked as third-party content.
    expect(result).toEqual({ ...upstream, _meta: { "dev.appstrate/third-party": true } });
    const call = callTool(made.calls)!;
    expect(await call.json()).toEqual({
      integration_package_id: REMOTE,
      name: "search",
      arguments: { q: "invoices" },
    });
    expect(call.headers.get("x-appstrate-connect-offers")).toBe("1");
  });

  it("refuses a missing required argument before calling", async () => {
    const made = makeTools(CALL_OWN, () => Response.json({}), true, fixture);
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: {} }, noExtra);
    expect(parseResult(result)).toMatchObject({ code: "missing_argument" });
    expect(callTool(made.calls)).toBeUndefined();
  });

  it("relays the route's refusal as an error result", async () => {
    const made = makeTools(
      CALL_OWN,
      () => problem(502, "bad_gateway", "The MCP server failed."),
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

describe("search_integration_tools — what a search says it leaves out", () => {
  const search = async (args: Record<string, unknown>, fixture: Fixture) => {
    const made = makeTools(CALL_OWN, undefined, true, fixture);
    return parseResult(await made.byName.get("search_integration_tools")!.handler(args, noExtra));
  };
  const named = (name: string, description = "Acme Items.") => apiCallTool({ name, description });

  it("ranks a tool whose name is the query first, whatever the listing order", async () => {
    const payload = await search(
      { query: "acme_items__folder" },
      { listing: listingOf([named("acme_items__folder_list"), named("acme_items__folder")]) },
    );
    expect((payload.best_match as { tool: string }).tool).toBe("acme_items__folder");
  });

  it("says when more tools match than are shown, naming the integration filter", async () => {
    const tools = Array.from({ length: 4 }, (_, i) => named(`acme_items__t${i}`));
    const payload = await search({ limit: 2 }, { listing: listingOf(tools) });
    expect(payload.total).toBe(4);
    expect((payload.tools as unknown[]).length).toBe(2);
    expect(payload.note).toContain("2 more tool(s)");
    expect(payload.note).toContain("`integration`");
    expect((await search({}, { listing: listingOf(tools) })).note).toBeUndefined();
  });

  it("says when a server lists more tools than are read", async () => {
    const payload = await search(
      {},
      {
        listing: listingOf([named(TOOL)], {
          truncated_catalogs: [{ integration_package_id: INTEGRATION, max_tools: 500 }],
        }),
      },
    );
    expect(payload.note).toContain(`${INTEGRATION}'s server lists more tools than the 500 read`);
  });

  it("says when the integration it filters on offers nothing", async () => {
    const payload = await search({ integration: "@acme/empty" }, { listing: listingOf([]) });
    expect(payload).toMatchObject({ total: 0, tools: [] });
    expect(payload.note).toContain("@acme/empty offers you no tool");
  });

  it("lists a remote integration whose server the platform refused to list, with that refusal", async () => {
    const refusal = { status: 429, code: "rate_limited", detail: "Too many requests." };
    const payload = await search(
      {},
      {
        listing: listingOf([named(TOOL)], {
          unlisted: [{ integration_package_id: "@acme/docs", refusal }],
        }),
      },
    );
    expect(payload.unlisted).toEqual([{ integration: "@acme/docs", refusal }]);
  });
});

describe("integration tools — descriptors", () => {
  it("keeps both descriptions under the 2 048 bytes the platform allows a third-party one", () => {
    for (const permissions of [CALL_OWN, [...CALL_OWN, "agents:run", "runs:read"]]) {
      const { byName } = makeTools(permissions);
      for (const name of BOTH) {
        const bytes = new TextEncoder().encode(byName.get(name)!.descriptor.description!).length;
        expect(bytes, name).toBeLessThan(2048);
      }
    }
  });
});

describe("call_integration_tool — a result past the budget", () => {
  const fixture: Fixture = {
    listing: listingOf([
      {
        kind: "remote",
        name: "acme_docs__search",
        integration_package_id: "@acme/docs",
        description: "Acme Docs.",
        remote_name: "search",
        input_schema: { type: "object" },
        connections: [connection({ missing_scopes: [] })],
      },
    ]),
  };

  it("says the tool ran, and drops only the blocks that do not fit", async () => {
    const big = "x".repeat(300 * 1024);
    const upstream = {
      content: [
        { type: "text", text: "head" },
        { type: "text", text: big },
        { type: "text", text: "tail" },
      ],
    };
    const made = makeTools(CALL_OWN, () => Response.json({ result: upstream }), true, fixture);
    const result = await made.byName
      .get("call_integration_tool")!
      .handler({ tool: "acme_docs__search", arguments: {} }, noExtra);
    const texts = (result.content as Array<{ text: string }>).map((block) => block.text);
    expect(texts[0]).toBe("head");
    expect(texts[1]).toContain("content block 1 omitted");
    expect(texts[2]).toBe("tail");
    expect(texts[3]).toContain("The tool ran");
    expect(result.isError).toBeUndefined();
    expect(result._meta).toEqual({ truncated: true, "dev.appstrate/third-party": true });
  });
});

describe("call_integration_tool — a batch's deadline", () => {
  it("stops sending at the deadline and keeps what was answered", async () => {
    const calls: Request[] = [];
    const ctx = {
      origin: "https://test.local",
      authHeaders: new Headers({ authorization: "Bearer tok" }),
      dispatch: async (req: Request) => {
        calls.push(req);
        if (calls.length === 1) return relayedJson({ ok: true });
        await new Promise((resolve) => {
          req.signal.addEventListener("abort", resolve, { once: true });
        });
        throw req.signal.reason;
      },
    };
    const outcome = await executeApiCall(
      ctx,
      { name: TOOL, integration: INTEGRATION, connections: [], connectionRequired: false },
      { requests: Array.from({ length: 6 }, () => get()) as never },
      noExtra,
      undefined,
      50,
    );
    if ("code" in outcome) throw new Error("refused");
    const payload = parseResult(outcome.result);
    const codes = (payload.results as Entry[]).map((entry) => entry.error?.code ?? entry.status);
    expect(codes[0]).toBe(200);
    expect(codes.slice(1, 4)).toEqual([
      "no_answer_before_deadline",
      "no_answer_before_deadline",
      "no_answer_before_deadline",
    ]);
    expect(codes.slice(4)).toEqual(["not_sent", "not_sent"]);
    expect(calls).toHaveLength(4);
    expect(payload.note).toContain("deadline");
    expect(outcome.result._meta).toEqual({ "dev.appstrate/third-party": true });
  });
});
