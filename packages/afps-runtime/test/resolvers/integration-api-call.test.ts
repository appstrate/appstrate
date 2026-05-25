// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
  readIntegrationRefs,
  readApiCallIntegrationMeta,
  apiCallToolName,
  type Bundle,
  type BundlePackage,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type PackageIdentity,
} from "../../src/bundle/index.ts";

const enc = new TextEncoder();

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "integration",
  files: Record<string, string>,
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) filesMap.set(k, enc.encode(v));
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

function makeBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

function makeCtx(): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    ctx: {
      emit: (e) => {
        events.push(e);
      },
      workspace: "/tmp",
      runId: "run_test",
      toolCallId: "call_1",
      signal: new AbortController().signal,
    },
  };
}

/** apiCall integration manifest helper (api_key auth with delivery.http). */
function apiKeyIntegrationManifest(
  _name: `@${string}/${string}`,
  opts: { authorizedUris?: string[]; allowAllUris?: boolean; headerName?: string } = {},
) {
  return {
    integration: {
      schema_version: "2.0",
      type: "integration",
      source: { kind: "api", api: {} },
      _meta: { "dev.appstrate/api": { auth_key: "main" } },
      auths: {
        main: {
          type: "api_key",
          authorized_uris: opts.authorizedUris ?? ["https://api.acme.com/**"],
          ...(opts.allowAllUris ? { allow_all_uris: true } : {}),
          credentials: { schema: {} },
          delivery: {
            http: {
              in: "header",
              name: opts.headerName ?? "X-Api-Key",
              value: "{$credential.api_key}",
            },
          },
        },
      },
    },
  };
}

describe("readIntegrationRefs", () => {
  it("reads dependencies.integrations as { name, version }[]", () => {
    const root = makePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: { integrations: { "@acme/api": "^1.0.0", "@x/y": "2.0.0" } },
      },
    );
    const bundle = makeBundle(root);
    const refs = readIntegrationRefs(bundle);
    expect(refs).toEqual([
      { name: "@acme/api", version: "^1.0.0" },
      { name: "@x/y", version: "2.0.0" },
    ]);
  });

  it("returns [] when no integrations declared", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    expect(readIntegrationRefs(makeBundle(root))).toEqual([]);
  });
});

describe("readApiCallIntegrationMeta", () => {
  it("projects authKey, authType, authorizedUris, delivery.http from the manifest", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/api", version: "^1" });
    expect(meta).not.toBeNull();
    expect(meta!.authKey).toBe("main");
    expect(meta!.authType).toBe("api_key");
    expect(meta!.authorizedUris).toEqual(["https://api.acme.com/**"]);
    expect(meta!.allowAllUris).toBe(false);
    expect(meta!.http?.headerName).toBe("X-Api-Key");
    expect(apiCallToolName(meta!)).toBe("acme_api__api_call");
  });

  it("returns null for an integration with no apiCall (pure MCP server)", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/mcp", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        source: { kind: "local", server: { name: "@acme/mcp-server", version: "^1.0.0" } },
        auths: {
          main: {
            type: "oauth2",
            authorized_uris: ["https://x/**"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    expect(readApiCallIntegrationMeta(bundle, { name: "@acme/mcp", version: "^1" })).toBeNull();
  });

  it("resolves the auth named by the apiCall block", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        source: { kind: "api", api: {} },
        _meta: { "dev.appstrate/api": { auth_key: "only" } },
        auths: {
          only: {
            type: "api_key",
            authorized_uris: ["https://api.acme.com/**"],
            delivery: {
              http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/api", version: "^1" });
    expect(meta!.authKey).toBe("only");
  });

  // ── toHttpDeliveryConfig branches ──
  // The `delivery.http.value` template is lowered onto the resolver's
  // `HttpDeliveryConfig.valueFrom`. A single `{$credential.field}` with no
  // encoding lowers to a bare field name; encoding or multi-ref values keep
  // the `{{field}}` template form.

  it("lowers a single {$credential.field} (no encoding) to a bare valueFrom field name", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/api", version: "^1" });
    // Single-ref fast path: lowered to a bare field name (not a template object).
    expect(meta!.http?.valueFrom).toBe("api_key");
  });

  it("keeps encoding=base64 as a { template, encoding } valueFrom", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/b64", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        source: { kind: "api", api: {} },
        _meta: { "dev.appstrate/api": { auth_key: "main" } },
        auths: {
          main: {
            type: "api_key",
            authorized_uris: ["https://api.acme.com/**"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                // Single credential ref BUT with base64 encoding — the single-ref
                // fast path is skipped, so the value stays a template object that
                // carries the encoding hint downstream.
                value: "{$credential.api_key}",
                encoding: "base64",
              },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/b64", version: "^1" });
    expect(meta!.http?.valueFrom).toEqual({ template: "{{api_key}}", encoding: "base64" });
  });

  it("rewrites a value with two {$credential.*} refs into {{field}} template syntax", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/basic", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        source: { kind: "api", api: {} },
        _meta: { "dev.appstrate/api": { auth_key: "main" } },
        auths: {
          main: {
            type: "basic",
            authorized_uris: ["https://api.acme.com/**"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Basic ",
                // Two refs → multi-ref path → template rewrite to `{{field}}`.
                value: "{$credential.username}:{$credential.password}",
              },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/basic", version: "^1" });
    expect(meta!.http?.valueFrom).toEqual({ template: "{{username}}:{{password}}" });
  });

  it("resolves the single declared auth for an api source with no _meta.auth_key", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/single", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        // api source, single auth, NO _meta["dev.appstrate/api"].auth_key —
        // the projector falls back to the single declared auth key.
        source: { kind: "api", api: {} },
        auths: {
          solo: {
            type: "api_key",
            authorized_uris: ["https://api.acme.com/**"],
            delivery: {
              http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/single", version: "^1" });
    expect(meta).not.toBeNull();
    expect(meta!.authKey).toBe("solo");
    expect(meta!.authType).toBe("api_key");
  });
});

describe("LocalIntegrationResolver", () => {
  it("injects the api_key header via the manifest delivery.http plan", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("acme_api__api_call");
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://api.acme.com/v1/me" }, ctx);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["X-Api-Key"]).toBe("secret");
  });

  it("injects oauth2 Bearer by default and substitutes {{var}} in the URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/oauth", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "2.0",
        type: "integration",
        source: { kind: "api", api: {} },
        _meta: { "dev.appstrate/api": { auth_key: "main" } },
        auths: {
          main: {
            type: "oauth2",
            authorization_endpoint: "https://x/auth",
            token_endpoint: "https://x/token",
            authorized_uris: ["https://{{subdomain}}.acme.com/**", "https://eu.acme.com/**"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      creds: {
        version: 1,
        integrations: {
          "@acme/oauth": { fields: { access_token: "tok", subdomain: "eu" } },
        },
      },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/oauth", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://{{subdomain}}.acme.com/me" }, ctx);
    expect(calls[0]!.url).toBe("https://eu.acme.com/me");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer tok");
  });

  it("enforces authorizedUris from the manifest (no allowAllUris)", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: (() =>
        Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await expect(
      tools[0]!.execute({ method: "GET", target: "https://evil.example.com/x" }, ctx),
    ).rejects.toThrow(/not in authorizedUris/);
  });

  it("strips a caller-supplied header of the same name (allowServerOverride default false)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "real" } } } },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      { method: "GET", target: "https://api.acme.com/v1/me", headers: { "x-api-key": "forged" } },
      ctx,
    );
    const h = calls[0]!.init.headers as Record<string, string>;
    // Only the injected value survives.
    const apiKeyHeaders = Object.entries(h).filter(([k]) => k.toLowerCase() === "x-api-key");
    expect(apiKeyHeaders).toHaveLength(1);
    expect(apiKeyHeaders[0]![1]).toBe("real");
  });

  it("honours an explicit injection override from the creds file", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      creds: {
        version: 1,
        integrations: {
          "@acme/api": {
            fields: { api_key: "secret" },
            injection: { headerName: "Authorization", headerPrefix: "Token " },
          },
        },
      },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://api.acme.com/v1/me" }, ctx);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Token secret");
  });

  it("skips integrations without apiCall and fails on missing creds", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({ creds: { version: 1, integrations: {} } });
    await expect(resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle)).rejects.toThrow(
      /no credentials found/,
    );
  });
});

describe("RemoteAppstrateIntegrationResolver", () => {
  it("POSTs to /api/credential-proxy/proxy with X-Integration = integration id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new RemoteAppstrateIntegrationResolver({
      instance: "https://app.appstrate.com",
      apiKey: "ask_test",
      applicationId: "app_1",
      orgId: "org_1",
      sessionId: "sess_1",
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    expect(tools[0]!.name).toBe("acme_api__api_call");
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://api.acme.com/v1/me" }, ctx);
    expect(calls[0]!.url).toBe("https://app.appstrate.com/api/credential-proxy/proxy");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer ask_test");
    expect(h["X-Application-Id"]).toBe("app_1");
    expect(h["X-Org-Id"]).toBe("org_1");
    expect(h["X-Integration"]).toBe("@acme/api");
    expect(h["X-Target"]).toBe("https://api.acme.com/v1/me");
  });

  it("does not enforce authorizedUris locally (platform gates server-side)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new RemoteAppstrateIntegrationResolver({
      instance: "https://app.appstrate.com",
      apiKey: "ask_test",
      applicationId: "app_1",
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    // off-allowlist target — must NOT throw locally; proxy decides.
    await tools[0]!.execute({ method: "GET", target: "https://anything.example.com/x" }, ctx);
    expect(calls).toHaveLength(1);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["X-Target"]).toBe("https://anything.example.com/x");
  });
});
