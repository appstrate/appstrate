// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure AFPS integration-manifest accessors — the
 * `source` discriminant narrowing (`local` | `remote` | `none`), the
 * orchestrated-connect `_meta` extension reader, and the
 * `{$credential.<field>}` value-template renderer. Pure functions, no DB.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { JSONSchemaObject } from "@appstrate/core/form";
import {
  renderCredentialTemplate,
  renderAuthAuthorizedUris,
  runnerEgressFor,
  getIntegrationSourceKind,
  getLocalServerRef,
  getRemoteSource,
  renderRemoteSource,
  getVariablesSchema,
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

describe("getIntegrationSourceKind", () => {
  it("returns each valid discriminant", () => {
    expect(getIntegrationSourceKind(manifest({ kind: "local" }))).toBe("local");
    expect(getIntegrationSourceKind(manifest({ kind: "remote" }))).toBe("remote");
    expect(getIntegrationSourceKind(manifest({ kind: "none" }))).toBe("none");
  });

  it("returns undefined for an unknown or absent kind", () => {
    expect(getIntegrationSourceKind(manifest({ kind: "weird" }))).toBeUndefined();
    expect(getIntegrationSourceKind(manifest(undefined))).toBeUndefined();
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

  // AFPS §7.1 — `source.server.vendored` is an optional boolean build-provenance
  // signal forwarded verbatim through the spawn spec → boot report so operators
  // can audit which runs used a vendored foreign mcp-server.
  it("forwards `source.server.vendored` when declared", () => {
    expect(
      getLocalServerRef(
        manifest({
          kind: "local",
          server: { name: "@x/srv", version: "^1.0.0", vendored: true },
        }),
      ),
    ).toEqual({ name: "@x/srv", version: "^1.0.0", vendored: true });
    expect(
      getLocalServerRef(
        manifest({
          kind: "local",
          server: { name: "@x/srv", version: "^1.0.0", vendored: false },
        }),
      ),
    ).toEqual({ name: "@x/srv", version: "^1.0.0", vendored: false });
  });

  it("omits `vendored` when absent or non-boolean (defensive parse)", () => {
    expect(
      getLocalServerRef(manifest({ kind: "local", server: { name: "@x/srv", version: "1" } })),
    ).toEqual({ name: "@x/srv", version: "1" });
    expect(
      getLocalServerRef(
        manifest({ kind: "local", server: { name: "@x/srv", version: "1", vendored: "yes" } }),
      ),
    ).toEqual({ name: "@x/srv", version: "1" });
  });
});

describe("getRemoteSource", () => {
  it.each(["streamable-http", "sse"] as const)("returns the remote url + %s transport", (t) => {
    expect(
      getRemoteSource(
        manifest({ kind: "remote", remote: { url: "https://mcp.example.com/v1", transport: t } }),
      ),
    ).toEqual({ url: "https://mcp.example.com/v1", transport: t });
  });

  it("returns null when source is not remote", () => {
    expect(getRemoteSource(manifest({ kind: "local", server: {} }))).toBeNull();
  });

  it("returns null when remote block is malformed", () => {
    expect(
      getRemoteSource(
        manifest({ kind: "remote", remote: { url: 1, transport: "streamable-http" } }),
      ),
    ).toBeNull();
    expect(getRemoteSource(manifest({ kind: "remote" }))).toBeNull();
  });

  /**
   * A transport outside AFPS §7.1's enum is malformed, not "close enough".
   *
   * This case used to assert the opposite — `transport: "http"` round-tripped
   * verbatim, because the helper checked only `typeof transport === "string"`.
   * That made every caller's narrowing a lie: the spawn resolver turned the
   * `string` into the union by mapping everything that was not `"sse"` onto
   * `"streamable-http"`, so a manifest declaring `"http"` or `"websocket"` was
   * silently rewritten into one declaring HTTP and handed to the sidecar
   * wearing a valid transport's name. Rejecting here is what lets the resolver
   * forward the value verbatim and the sidecar's own guard mean something.
   */
  it.each(["http", "websocket", "STREAMABLE-HTTP", ""])(
    "returns null for a transport outside the enum: %p",
    (transport) => {
      expect(
        getRemoteSource(
          manifest({ kind: "remote", remote: { url: "https://mcp.example.com/v1", transport } }),
        ),
      ).toBeNull();
    },
  );
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
  it("renders a variable entry from the connection's variables, dropping an invalid value", () => {
    const forge = { authorized_uris: ["{$variable.base_url}/api/v4/**"] };
    expect(renderAuthAuthorizedUris(forge, {}, { base_url: "https://forge.example.com/" })).toEqual(
      ["https://forge.example.com/api/v4/**"],
    );
    expect(renderAuthAuthorizedUris(forge, {}, { base_url: "https://x.example/?q" })).toEqual([]);
    expect(renderAuthAuthorizedUris(forge, {}, {})).toEqual([]);
  });
});

describe("runnerEgressFor", () => {
  it("is undefined when the auth declares no outbound surface", () => {
    expect(runnerEgressFor({}, [])).toBeUndefined();
    expect(runnerEgressFor({ authorized_uris: [] }, [])).toBeUndefined();
  });

  it("carries the rendered list, even when rendering emptied it (deny-all)", () => {
    const auth = { authorized_uris: ["ssh://{$credential.host}:22"] };
    expect(runnerEgressFor(auth, [])).toEqual({ authorizedUris: [], allowAllUris: false });
    expect(runnerEgressFor(auth, ["ssh://h:22"])).toEqual({
      authorizedUris: ["ssh://h:22"],
      allowAllUris: false,
    });
  });

  it("carries allow_all_uris", () => {
    expect(runnerEgressFor({ allow_all_uris: true }, [])).toEqual({
      authorizedUris: [],
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

  it("getVariablesSchema reads variables.schema, null when undeclared", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { base_url: { type: "string" } },
    };
    expect(
      getVariablesSchema({ ...templated, variables: { schema } } as unknown as IntegrationManifest),
    ).toBe(schema);
    expect(getVariablesSchema(templated)).toBeNull();
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
