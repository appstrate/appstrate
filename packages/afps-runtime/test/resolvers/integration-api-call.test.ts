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
      apiCall: { authKey: "main" },
      auths: {
        main: {
          type: "api_key",
          authorizedUris: opts.authorizedUris ?? ["https://api.acme.com/**"],
          ...(opts.allowAllUris ? { allowAllUris: true } : {}),
          credentials: { schema: {} },
          delivery: { http: { headerName: opts.headerName ?? "X-Api-Key" } },
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
        server: { type: "node", entryPoint: "index.js" },
        auths: {
          main: { type: "oauth2", authorizedUris: ["https://x/**"], delivery: { http: {} } },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    expect(readApiCallIntegrationMeta(bundle, { name: "@acme/mcp", version: "^1" })).toBeNull();
  });

  it("infers the single auth when apiCall.authKey is omitted", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const integ = makePackage("@acme/api", "1.0.0", "integration", {
      "integration.json": JSON.stringify({
        apiCall: {},
        auths: {
          only: {
            type: "api_key",
            authorizedUris: ["https://api.acme.com/**"],
            delivery: { http: {} },
          },
        },
      }),
    });
    const bundle = makeBundle(root, [integ]);
    const meta = readApiCallIntegrationMeta(bundle, { name: "@acme/api", version: "^1" });
    expect(meta!.authKey).toBe("only");
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
        apiCall: { authKey: "main" },
        auths: {
          main: {
            type: "oauth2",
            authorizationUrl: "https://x/auth",
            tokenUrl: "https://x/token",
            authorizedUris: ["https://{{subdomain}}.acme.com/**", "https://eu.acme.com/**"],
            delivery: { http: {} },
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
  it("POSTs to /api/credential-proxy/proxy with X-Provider = integration id", async () => {
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
    expect(h["X-Provider"]).toBe("@acme/api");
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
