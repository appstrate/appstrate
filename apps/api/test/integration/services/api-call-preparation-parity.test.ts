// SPDX-License-Identifier: Apache-2.0

/**
 * The three `api_call` paths — the platform's `proxyCall`, the sidecar's `executeApiCall` and the
 * CLI's `LocalIntegrationResolver` — put the same request on the wire for the same call and the
 * same connection, hostile credential values included, and refuse the same ones.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { LocalIntegrationResolver, type Bundle } from "@appstrate/afps-runtime/resolvers";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { executeApiCall } from "../../../../../runtime-pi/sidecar/credential-proxy.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { apiIntegrationManifest, httpHeaderDelivery } from "../../helpers/integration-manifests.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";

const PACKAGE_ID = "@apicallparity/api";
const ALLOWLIST = ["https://api.acme.com/**"];
const HOSTILE = 'a&b=c#d/e?f "g"\\ h+i%2F';

const manifest = apiIntegrationManifest({
  name: PACKAGE_ID,
  apiCall: { authKey: "api" },
  auths: {
    api: {
      type: "custom",
      authorizedUris: ALLOWLIST,
      credentialFields: ["api_key", "base", "v"],
      requiredCredentialFields: ["api_key"],
      delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
    },
  },
});

interface Call {
  target: string;
  headers?: Record<string, string>;
  body?: string;
  /** A structured JSON body, which only the sidecar takes (the other two take text). */
  json?: unknown;
  /** Defaults to true. */
  substituteBody?: boolean;
}
type Sent = { url: string; headers: Record<string, string>; body: string };
type Outcome = Sent | { refused: string };

/** A transport recording the one request it is given, as its caller's headers and body text. */
function wire(call: Call) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: url.toString(),
      headers: Object.fromEntries(
        Object.keys(call.headers ?? {}).map((name) => [name, headers.get(name) ?? ""]),
      ),
      body: init?.body == null ? "" : await new Response(init.body).text(),
    });
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const resolveHost = async () => ["203.0.113.7"];
const outcome = (sent: Sent[], refusal: string | undefined): Outcome =>
  refusal === undefined ? sent[0]! : { refused: refusal };

function bundleOf(fields: Record<string, string>): { bundle: Bundle; fields: typeof fields } {
  const pkg = (m: { name: string; version: string }): BundlePackage => {
    const files = new Map([["manifest.json", new TextEncoder().encode(JSON.stringify(m))]]);
    return {
      identity: `${m.name}@${m.version}` as PackageIdentity,
      manifest: m,
      files,
      integrity: recordIntegrity(serializeRecord(computeRecordEntries(files))),
    };
  };
  const root = pkg({ name: "@apicallparity/agent", version: "1.0.0" });
  const packages = new Map([root, pkg(manifest)].map((p) => [p.identity, p]));
  const index = new Map(
    [...packages.values()].map((p) => [
      p.identity,
      { path: `${p.identity}/`, integrity: p.integrity },
    ]),
  );
  return {
    fields,
    bundle: {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      root: root.identity,
      packages,
      integrity: bundleIntegrity(index),
    },
  };
}

describe("api_call — one prepared request on the three paths", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "apicallparity" });
    await seedProxyIntegration(ctx, manifest);
  });

  async function platform(call: Call, fields: Record<string, string>): Promise<Outcome> {
    await seedProxyConnection(ctx, PACKAGE_ID, "api", fields);
    const { fetchImpl, sent } = wire(call);
    const refusal = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      reach: "own",
      integrationId: PACKAGE_ID,
      method: "POST",
      target: call.target,
      headers: call.headers ?? {},
      body: call.body ?? null,
      substituteBody: call.substituteBody ?? true,
      fetch: fetchImpl,
      resolveHost,
    }).then(
      () => undefined,
      (e: { code: string }) => e.code,
    );
    return outcome(sent, refusal);
  }

  async function sidecar(call: Call, fields: Record<string, string>): Promise<Outcome> {
    const { fetchImpl, sent } = wire(call);
    const result = await executeApiCall(
      {
        integrationId: PACKAGE_ID,
        connectionId: "conn-1",
        targetUrl: call.target,
        method: "POST",
        callerHeaders: call.headers ?? {},
        body:
          call.json !== undefined
            ? { kind: "json", value: call.json }
            : call.body === undefined
              ? { kind: "none" }
              : {
                  kind: "buffered",
                  bytes: new TextEncoder().encode(call.body).buffer as ArrayBuffer,
                  text: call.body,
                },
        substituteBody: call.substituteBody ?? true,
      },
      {
        config: { runToken: "rt", platformApiUrl: "http://platform" },
        cookieJar: new Map(),
        fetchFn: fetchImpl,
        declaredUris: ALLOWLIST,
        fetchCredentials: async () => ({
          credentials: fields,
          authorizedUris: ALLOWLIST,
          allowAllUris: false,
          credentialHeaderName: "X-Api-Key",
          credentialFieldName: "api_key",
        }),
        reportedAuthFailures: new Set<string>(),
        resolveHost,
      },
    );
    return outcome(sent, result.ok ? undefined : (result.code ?? result.error));
  }

  async function cli(call: Call, fields: Record<string, string>): Promise<Outcome> {
    const { fetchImpl, sent } = wire(call);
    const resolver = new LocalIntegrationResolver({
      creds: { version: 1, integrations: { [PACKAGE_ID]: { fields } } },
      fetch: fetchImpl,
      resolveHost,
    });
    const [tool] = await resolver.resolve(
      [{ name: PACKAGE_ID, version: "^1" }],
      bundleOf(fields).bundle,
    );
    const refusal = await tool!
      .execute(
        {
          method: "POST",
          target: call.target,
          headers: call.headers,
          body: call.body,
          substituteBody: call.substituteBody ?? true,
        },
        {
          emit: () => {},
          workspace: "/tmp",
          runId: "run_test",
          toolCallId: "call_1",
          signal: new AbortController().signal,
        },
      )
      .then(
        () => undefined,
        (e: { code: string }) => e.code,
      );
    return outcome(sent, refusal);
  }

  const fields = { api_key: "k-1", base: "https://api.acme.com/app", v: HOSTILE };

  it.each<[string, Call, Sent]>([
    [
      "a path segment and a query component",
      { target: "{{base}}/users/{{v}}/keys?q={{v}}&page=2" },
      {
        url: `https://api.acme.com/app/users/${encodeURIComponent(HOSTILE)}/keys?q=${encodeURIComponent(HOSTILE)}&page=2`,
        headers: {},
        body: "",
      },
    ],
    [
      "a header value",
      { target: "https://api.acme.com/x", headers: { "X-Tenant": "t-{{v}}" } },
      { url: "https://api.acme.com/x", headers: { "X-Tenant": `t-${HOSTILE}` }, body: "" },
    ],
    [
      "a JSON body",
      {
        target: "https://api.acme.com/x",
        headers: { "Content-Type": "application/json" },
        body: '{"k":"{{v}}","n":1}',
      },
      {
        url: "https://api.acme.com/x",
        headers: { "Content-Type": "application/json" },
        body: `{"k":${JSON.stringify(HOSTILE)},"n":1}`,
      },
    ],
    [
      "a form body",
      {
        target: "https://api.acme.com/x",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "k={{v}}&n=1",
      },
      {
        url: "https://api.acme.com/x",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `${new URLSearchParams({ k: HOSTILE })}&n=1`,
      },
    ],
    [
      "a text/plain body, as is",
      {
        target: "https://api.acme.com/x",
        headers: { "Content-Type": "text/plain" },
        body: "k={{v}}",
      },
      {
        url: "https://api.acme.com/x",
        headers: { "Content-Type": "text/plain" },
        body: `k=${HOSTILE}`,
      },
    ],
    [
      "a body it was not asked to substitute, untouched",
      {
        target: "https://api.acme.com/x",
        headers: { "Content-Type": "application/json" },
        body: '{"k":"{{v}}"}',
        substituteBody: false,
      },
      {
        url: "https://api.acme.com/x",
        headers: { "Content-Type": "application/json" },
        body: '{"k":"{{v}}"}',
      },
    ],
  ])("sends %s encoded for its place, identically", async (_place, call, expected) => {
    expect(await platform(call, fields)).toEqual(expected);
    expect(await sidecar(call, fields)).toEqual(expected);
    expect(await cli(call, fields)).toEqual(expected);
  });

  it("the sidecar's structured JSON body puts the same bytes on the wire as the text one", async () => {
    const target = "https://api.acme.com/x";
    const headers = { "Content-Type": "application/json" };
    const text = await platform({ target, headers, body: '{"k":"{{v}}","n":1}' }, fields);
    expect(await sidecar({ target, headers, json: { k: "{{v}}", n: 1 } }, fields)).toEqual(text);
    expect(text).toMatchObject({ body: `{"k":${JSON.stringify(HOSTILE)},"n":1}` });
  });

  it.each<[string, Call, string]>([
    [
      "a header value with a line break",
      { target: "https://api.acme.com/x", headers: { "X-Tenant": "{{v}}" } },
      "a\r\nX-Evil: 1",
    ],
    ["a dot segment in the path", { target: "https://api.acme.com/users/{{v}}/keys" }, ".."],
    ["an empty path segment", { target: "https://api.acme.com/users/{{v}}/keys" }, ""],
    [
      "a multipart value holding the boundary",
      {
        target: "https://api.acme.com/x",
        headers: { "Content-Type": "multipart/form-data; boundary=B" },
        body: '--B\r\nContent-Disposition: form-data; name="k"\r\n\r\n{{v}}\r\n--B--',
      },
      "--B--",
    ],
  ])("refuses %s as an unusable credential, sending nothing", async (_what, call, v) => {
    const refused = { refused: "credential_unusable" };
    expect(await platform(call, { ...fields, v })).toEqual(refused);
    expect(await sidecar(call, { ...fields, v })).toEqual(refused);
    expect(await cli(call, { ...fields, v })).toEqual(refused);
  });

  // One refusal of the shared preparation, under each door's own code for it.
  const BODY = {
    platform: "invalid_request",
    sidecar: "invalid_body",
    cli: "RESOLVER_BODY_INVALID",
  };
  const HEADER = {
    platform: "invalid_request",
    sidecar: "invalid_header",
    cli: "RESOLVER_HEADER_INVALID",
  };
  const json = '{"k":"{{v}}"}';
  it.each<[string, Omit<Call, "target">, typeof BODY]>([
    ["a body with a placeholder and no Content-Type", { body: json }, BODY],
    [
      "a body with a placeholder under a media type with no encoder",
      { headers: { "Content-Type": "application/graphql" }, body: json },
      BODY,
    ],
    [
      "a body with a placeholder under a Content-Type that is one",
      { headers: { "Content-Type": "{{base}}" }, body: json },
      BODY,
    ],
    [
      "a multipart part header with a placeholder outside a quoted string",
      {
        headers: { "Content-Type": "multipart/form-data; boundary=B" },
        body: "--B\r\nContent-Disposition: form-data; name={{v}}\r\n\r\nx\r\n--B--",
      },
      BODY,
    ],
    ["one header name written twice", { headers: { "X-A": "1", "x-a": "2" } }, HEADER],
  ])("refuses %s as the request's fault, sending nothing", async (_what, call, codes) => {
    const request = { target: "https://api.acme.com/x", ...call };
    expect(await platform(request, fields)).toEqual({ refused: codes.platform });
    expect(await sidecar(request, fields)).toEqual({ refused: codes.sidecar });
    expect(await cli(request, fields)).toEqual({ refused: codes.cli });
  });
});
