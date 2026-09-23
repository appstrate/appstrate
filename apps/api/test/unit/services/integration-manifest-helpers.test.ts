// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure AFPS integration-manifest accessors — the
 * `source` discriminant narrowing (`local` | `remote` | `none`), the
 * orchestrated-connect `_meta` extension reader, and the
 * `{$credential.<field>}` value-template renderer. Pure functions, no DB.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  renderCredentialTemplate,
  getIntegrationSourceKind,
  getLocalServerRef,
  getRemoteSource,
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
    expect(renderCredentialTemplate("Bearer {$credential.token}", { token: "abc" })).toBe(
      "Bearer abc",
    );
  });

  it("renders unknown refs as empty but keeps surrounding literal text", () => {
    // A partial render still has the literal prefix, so it is non-empty.
    expect(renderCredentialTemplate("k={$credential.missing}", {})).toBe("k=");
  });

  it("returns null when the whole template resolves to empty (field absent → skip)", () => {
    // A bare ref against a missing field collapses to "" → null, so the caller
    // skips emitting the env var / file entirely.
    expect(renderCredentialTemplate("{$credential.absent}", {})).toBeNull();
  });

  it("handles multiple refs in one template", () => {
    expect(renderCredentialTemplate("{$credential.a}:{$credential.b}", { a: "1", b: "2" })).toBe(
      "1:2",
    );
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
