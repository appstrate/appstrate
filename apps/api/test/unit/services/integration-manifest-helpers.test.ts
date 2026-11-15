// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure AFPS integration-manifest accessors — the local
 * server reference, the orchestrated-connect `_meta` extension reader, and the
 * `{$credential.<field>}` value-template renderer. Pure functions, no DB.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  renderCredentialTemplate,
  renderAuthAuthorizedUris,
  runnerEgressFor,
  getLocalServerRef,
  renderRemoteSource,
  hasPerConnectionAuthServer,
  getAppstrateConnectMeta,
  authKeysServingSelection,
  type AfpsManifestConnect,
} from "../../../src/services/integration-manifest-helpers.ts";

function manifest(source: unknown, auths?: Record<string, unknown>): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    source,
    auths,
  } as unknown as IntegrationManifest;
}

describe("renderCredentialTemplate", () => {
  it("substitutes known refs and returns the rendered string", () => {
    expect(renderCredentialTemplate("Bearer {$credential.token}", { token: "abc" }, {})).toBe(
      "Bearer abc",
    );
  });

  it("renders unknown refs as empty but keeps surrounding literal text", () => {
    // A partial render still has the literal prefix, so it is non-empty.
    expect(renderCredentialTemplate("k={$credential.missing}", {}, {})).toBe("k=");
  });

  it("returns null when the whole template resolves to empty (field absent → skip)", () => {
    // A bare ref against a missing field collapses to "" → null, so the caller
    // skips emitting the env var / file entirely.
    expect(renderCredentialTemplate("{$credential.absent}", {}, {})).toBeNull();
  });

  it("handles multiple refs in one template", () => {
    expect(
      renderCredentialTemplate("{$credential.a}:{$credential.b}", { a: "1", b: "2" }, {}),
    ).toBe("1:2");
  });
  it("renders the connection's variables beside its credential fields", () => {
    expect(
      renderCredentialTemplate(
        "{$variable.base_url}|{$credential.token}",
        { token: "t" },
        { base_url: "https://forge.example.com" },
      ),
    ).toBe("https://forge.example.com|t");
    expect(renderCredentialTemplate("{$variable.absent}", {}, {})).toBeNull();
  });
});

describe("getLocalServerRef", () => {
  it("returns the referenced mcp-server name + version", () => {
    expect(
      getLocalServerRef(manifest({ kind: "local", server: { name: "@x/srv", version: "^1.0.0" } })),
    ).toEqual({ name: "@x/srv", version: "^1.0.0" });
  });

  it("returns null when source is not local", () => {
    expect(getLocalServerRef(manifest({ kind: "remote", remote: {} }))).toBeNull();
  });

  it("returns null when server ref is malformed (non-string fields)", () => {
    expect(
      getLocalServerRef(manifest({ kind: "local", server: { name: 42, version: "1" } })),
    ).toBeNull();
    expect(getLocalServerRef(manifest({ kind: "local" }))).toBeNull();
  });
});

describe("getAppstrateConnectMeta", () => {
  it("reads the orchestrated-tool extension off the connect block", () => {
    const connect: AfpsManifestConnect = {
      tool: {},
      _meta: { "dev.appstrate/connect": { tool: "login", run_at: "run-start" } },
    };
    expect(getAppstrateConnectMeta(connect)).toEqual({ tool: "login", run_at: "run-start" });
  });

  it("returns undefined when the connect block or meta is absent", () => {
    expect(getAppstrateConnectMeta(undefined)).toBeUndefined();
    expect(getAppstrateConnectMeta({ tool: {} })).toBeUndefined();
  });
});

describe("authKeysServingSelection", () => {
  const AUTHS = { oauth: { type: "oauth2" }, pat: { type: "api_key" } };
  function serverless(apiAuths?: Record<string, unknown>): IntegrationManifest {
    const m = manifest({ kind: "none" }, AUTHS) as unknown as Record<string, unknown>;
    if (apiAuths) m._meta = { "dev.appstrate/api": { auths: apiAuths } };
    return m as unknown as IntegrationManifest;
  }

  it("names the auths whose api_call tool is selected", () => {
    const m = serverless({ oauth: {}, pat: {} });
    expect(authKeysServingSelection(m, ["api_call__pat"])).toEqual(new Set(["pat"]));
    expect(authKeysServingSelection(m, "*")).toEqual(new Set(["oauth", "pat"]));
  });

  // No auth serving is not a connection problem: refusing every connection
  // for it would name a remedy (another connection) that cannot exist.
  it("is null, not empty, when the manifest exposes no api_call tool", () => {
    expect(authKeysServingSelection(serverless(), "*")).toBeNull();
    expect(authKeysServingSelection(serverless(), ["search"])).toBeNull();
  });

  it("is null, not empty, when the selection names no current api_call tool", () => {
    expect(
      authKeysServingSelection(serverless({ oauth: {}, pat: {} }), ["api_call__gone"]),
    ).toBeNull();
  });
});

describe("renderAuthAuthorizedUris", () => {
  const ssh = { authorized_uris: ["ssh://{$credential.host}:{$credential.port}"] };

  it("renders a templated entry from the connection's fields", () => {
    expect(renderAuthAuthorizedUris(ssh, { host: "h", port: "22" }, {})).toEqual(["ssh://h:22"]);
  });

  it("drops a templated entry whose field is missing (deny-all), never the raw template", () => {
    expect(renderAuthAuthorizedUris(ssh, { host: "h" }, {})).toEqual([]);
  });

  it("drops a templated entry whose value is not a literal host label or port", () => {
    expect(renderAuthAuthorizedUris(ssh, { host: "a.com:443", port: "22" }, {})).toEqual([]);
    expect(renderAuthAuthorizedUris(ssh, { host: "*", port: "22" }, {})).toEqual([]);
  });

  it("passes static entries unchanged and treats an absent list as empty", () => {
    expect(renderAuthAuthorizedUris({ authorized_uris: ["https://a.example/**"] }, {}, {})).toEqual(
      ["https://a.example/**"],
    );
    expect(renderAuthAuthorizedUris({}, {}, {})).toEqual([]);
  });
});

describe("runnerEgressFor", () => {
  it("is undefined when the auth declares no outbound surface", () => {
    expect(runnerEgressFor({}, [])).toBeUndefined();
    expect(runnerEgressFor({ authorized_uris: [] }, [])).toBeUndefined();
  });

  it("carries the rendered list, even when rendering emptied it (deny-all), and the declared one", () => {
    const declaredUris = ["ssh://{$credential.host}:22"];
    const auth = { authorized_uris: declaredUris };
    expect(runnerEgressFor(auth, [])).toEqual({
      authorizedUris: [],
      declaredUris,
      allowAllUris: false,
    });
    expect(runnerEgressFor(auth, ["ssh://h:22"])).toEqual({
      authorizedUris: ["ssh://h:22"],
      declaredUris,
      allowAllUris: false,
    });
  });

  it("carries allow_all_uris", () => {
    expect(runnerEgressFor({ allow_all_uris: true }, [])).toEqual({
      authorizedUris: [],
      declaredUris: [],
      allowAllUris: true,
    });
  });
});

describe("connection variables (AFPS §7.12)", () => {
  const templated = manifest({
    kind: "remote",
    remote: { url: "{$variable.base_url}/api/v4/mcp", transport: "streamable-http" },
  });

  it("renderRemoteSource renders a template per connection, a literal as it is", () => {
    expect(renderRemoteSource(templated, { base_url: "https://gitlab.example.com/" })).toEqual({
      url: "https://gitlab.example.com/api/v4/mcp",
      transport: "streamable-http",
    });
    expect(renderRemoteSource(templated, null)).toBeNull();
    expect(renderRemoteSource(templated, { base_url: "https://u@gitlab.example.com" })).toBeNull();
    const literal = manifest({
      kind: "remote",
      remote: { url: "https://mcp.example.com/v1", transport: "sse" },
    });
    expect(renderRemoteSource(literal, null)).toEqual({
      url: "https://mcp.example.com/v1",
      transport: "sse",
    });
    expect(renderRemoteSource(manifest({ kind: "none" }), null)).toBeNull();
  });

  it("hasPerConnectionAuthServer: oauth2 under a templated issuer or remote url", () => {
    const literal = manifest({ kind: "remote", remote: { url: "https://x.example.com/mcp" } });
    expect(hasPerConnectionAuthServer(templated, { type: "oauth2" })).toBe(true);
    expect(hasPerConnectionAuthServer(templated, { type: "api_key" })).toBe(false);
    expect(
      hasPerConnectionAuthServer(literal, {
        type: "oauth2",
        issuer: "https://{$variable.tenant}.idp.example.com",
      }),
    ).toBe(true);
    expect(
      hasPerConnectionAuthServer(literal, { type: "oauth2", issuer: "https://idp.example.com" }),
    ).toBe(false);
  });
});
