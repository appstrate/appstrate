// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `list_connections` and `api_call`: when they are declared, what request each
 * one dispatches to the credential proxy, and what the model is handed back. Dispatch is
 * injected, so the proxy's own answers (its guard, its access rule, its refusals) are stubbed
 * here and exercised for real in `src/modules/mcp/test/integration/connection-tools.test.ts`.
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

function makeTools(
  permissions: string[],
  respond: Respond = () => relayedJson({ ok: true }),
  proxyAcceptsCredential = true,
) {
  const calls: Request[] = [];
  const events: McpToolEvent[] = [];
  const dispatch: Dispatch = async (req) => {
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
    mayShareRoot: async () => false,
    readSkill: () => Promise.reject(new Error("read_skill is not exercised here")),
    requestId: "req_test",
  };
  const tools = toolsFor(ctx, proxyAcceptsCredential);
  const byName = new Map(tools.map((tool) => [tool.descriptor.name, tool]));
  return { byName, calls, events };
}

const get = (overrides: Record<string, unknown> = {}) => ({
  integration_package_id: INTEGRATION,
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
  const result = await made.byName.get("api_call")!.handler(args, extra);
  return { ...made, result, payload: parseResult(result) };
}

type Entry = Record<string, unknown> & { error?: Record<string, unknown> };
const entries = (payload: Record<string, unknown>) => payload.results as Entry[];

describe("connection tools — declaration", () => {
  const names = (permissions: string[], proxyAcceptsCredential = true): string[] => [
    ...makeTools(permissions, undefined, proxyAcceptsCredential).byName.keys(),
  ];

  it("withholds both without `mcp:invoke`: a read-only connection calls nothing", () => {
    const declared = names(["mcp:read", "credential-proxy:call-own"]);
    expect(declared).not.toContain("list_connections");
    expect(declared).not.toContain("api_call");
  });

  it("declares both under either permission of a call outside a run", () => {
    // `credential-proxy:call` implies `call-own`: the closed set of either declares the tools.
    for (const permission of ["credential-proxy:call-own", "credential-proxy:call"]) {
      const declared = names([...withImpliedPermissions(["mcp:read", "mcp:invoke", permission])]);
      expect(declared, permission).toContain("list_connections");
      expect(declared, permission).toContain("api_call");
    }
  });

  it("withholds both when the proxy would refuse the credential the request carries", () => {
    const declared = names(CALL_OWN, false);
    expect(declared).not.toContain("list_connections");
    expect(declared).not.toContain("api_call");
    expect(declared).toContain("invoke_operation");
  });

  it("names run_and_wait only to a caller who is offered it", () => {
    const description = (permissions: string[], name: string) =>
      makeTools(permissions).byName.get(name)!.descriptor.description!;
    const runner = [...CALL_OWN, "agents:run", "runs:read"];
    for (const name of ["list_connections", "api_call"]) {
      expect(description(runner, name)).toContain("run_and_wait");
      expect(description(CALL_OWN, name)).not.toContain("run_and_wait");
    }
  });
});

describe("list_connections", () => {
  const row = {
    integration_package_id: INTEGRATION,
    connection_id: "8a6f2f0e-1c1b-4c58-9a36-0d7b7a1f3c11",
    label: "acct-1",
    owned_by_actor: true,
    auth_key: "api",
    scopes_granted: [],
    authorized_uris: ["https://api.example.com/**"],
    allow_all_uris: false,
    needs_reconnection: false,
    call_permission_required: false,
  };

  it("reads the route in-process, as the caller, and returns its rows", async () => {
    const { byName, calls, events } = makeTools(CALL_OWN, () =>
      Response.json({ object: "list", data: [row], hasMore: false }),
    );
    const result = await byName.get("list_connections")!.handler({}, noExtra);

    expect(result.isError).toBe(false);
    expect(parseResult(result)).toEqual({ connections: [row] });
    expect(result.structuredContent).toEqual({ connections: [row] });

    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/api/credential-proxy/connections");
    expect(req.headers.get("authorization")).toBe("Bearer tok");
    expect(req.headers.get("x-space-id")).toBe("spc_1");
    const [marker, value] = internalDispatchHeader();
    expect(req.headers.get(marker)).toBe(value);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "list_connections",
        status: 200,
        outcome: "invoked",
        shownCount: 1,
      }),
    ]);
  });

  it("relays the route's refusal as `{ status, body }`", async () => {
    const { byName } = makeTools(CALL_OWN, () => problem(403, "forbidden", "Insufficient"));
    const result = await byName.get("list_connections")!.handler({}, noExtra);
    expect(result.isError).toBe(true);
    const payload = parseResult(result);
    expect(payload.status).toBe(403);
    expect((payload.body as { code: string }).code).toBe("forbidden");
  });
});

describe("api_call — arguments", () => {
  const refused = async (args: Record<string, unknown>) => {
    const { result, payload, calls, events } = await apiCall(args);
    expect(result.isError).toBe(true);
    // Refused whole: nothing reaches the proxy, and a batch never runs in part.
    expect(calls).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({ tool: "api_call", outcome: "rejected" })]);
    return payload;
  };

  it("requires `requests`, 1 to 50 of them", async () => {
    expect(await refused({})).toMatchObject({
      code: "missing_argument",
      arguments: ["requests"],
    });
    expect(await refused({ requests: [] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests"],
    });
    expect(await refused({ requests: Array.from({ length: 51 }, () => get()) })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests"],
    });
  });

  it("names the request and field at fault", async () => {
    expect(await refused({ requests: [get(), get({ method: "FETCH" })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests[1].method"],
    });
    expect(
      await refused({ requests: [{ integration_package_id: INTEGRATION, method: "GET" }] }),
    ).toMatchObject({ code: "invalid_argument", arguments: ["requests[0].target"] });
    expect(await refused({ requests: [get({ body: 42 })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests[0].body"],
    });
  });

  it("refuses a request field it does not declare instead of dropping it", async () => {
    // The sidecar's camelCase spelling: silently ignored, the body would go out unsubstituted.
    expect(await refused({ requests: [get({ substituteBody: true })] })).toMatchObject({
      code: "unknown_argument",
      arguments: ["requests[0].substituteBody"],
    });
  });

  it("refuses a body on GET", async () => {
    expect(await refused({ requests: [get({ body: { a: 1 } })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests[0].body"],
    });
  });

  it("refuses a session id that is not a UUID v4, and an out-of-range cap", async () => {
    expect(await refused({ requests: [get()], session_id: "session-1" })).toMatchObject({
      code: "invalid_argument",
      arguments: ["session_id"],
    });
    expect(await refused({ requests: [get()], max_response_bytes: 262_145 })).toMatchObject({
      code: "invalid_argument",
      arguments: ["max_response_bytes"],
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
        arguments: [`requests[1].headers.${name}`],
      });
    }
  });

  it("refuses a header or a target `Headers` cannot carry", async () => {
    expect(await refused({ requests: [get({ headers: { "X Bad": "v" } })] })).toMatchObject({
      code: "invalid_argument",
      arguments: ["requests[0].headers.X Bad"],
    });
    expect(
      await refused({ requests: [get({ target: `${TARGET}\r\nX-Run-Id: run_1` })] }),
    ).toMatchObject({ code: "invalid_argument", arguments: ["requests[0].target"] });
  });
});

describe("api_call — dispatch", () => {
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
      .get("api_call")!
      .handler({ requests: Array.from({ length: 10 }, () => get()) }, {
        signal: controller.signal,
      } as unknown as AppstrateRequestExtra);
    await expect(call).rejects.toThrow("client went away");
    // The three already in flight, and none of the seven behind them.
    expect(made.calls).toHaveLength(3);
  });
});

describe("api_call — result", () => {
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
      expect.objectContaining({ tool: "api_call", outcome: "invoked", shownCount: 2 }),
    ]);
  });
});
