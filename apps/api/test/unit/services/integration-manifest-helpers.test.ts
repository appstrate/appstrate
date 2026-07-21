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
  getBrowserConnectExecutor,
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
  it("returns the remote url + transport", () => {
    expect(
      getRemoteSource(
        manifest({
          kind: "remote",
          remote: { url: "https://mcp.example.com/v1", transport: "http" },
        }),
      ),
    ).toEqual({ url: "https://mcp.example.com/v1", transport: "http" });
  });

  it("returns null when source is not remote", () => {
    expect(getRemoteSource(manifest({ kind: "local", server: {} }))).toBeNull();
  });

  it("returns null when remote block is malformed", () => {
    expect(
      getRemoteSource(manifest({ kind: "remote", remote: { url: 1, transport: "http" } })),
    ).toBeNull();
    expect(getRemoteSource(manifest({ kind: "remote" }))).toBeNull();
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

describe("getBrowserConnectExecutor", () => {
  it("parses the strict browser executor marker", () => {
    const connect: AfpsManifestConnect = {
      tool: {},
      _meta: {
        "dev.appstrate/connect": {
          tool: "login",
          executor: { kind: "browser", session_mode: "exportable" },
        },
      },
    };
    expect(getBrowserConnectExecutor(connect)).toEqual({
      kind: "browser",
      session_mode: "exportable",
    });
  });

  it("fails closed for unknown executor policy fields", () => {
    const connect: AfpsManifestConnect = {
      tool: {},
      _meta: {
        "dev.appstrate/connect": {
          executor: { kind: "browser", session_mode: "exportable", unsafe: true },
        },
      },
    };
    expect(() => getBrowserConnectExecutor(connect)).toThrow(/unknown fields/);
  });
});
