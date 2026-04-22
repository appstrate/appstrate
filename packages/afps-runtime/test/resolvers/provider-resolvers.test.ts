// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  makeProviderTool,
  SidecarProviderResolver,
  LocalProviderResolver,
  RemoteAppstrateProviderResolver,
  type Bundle,
  type BundlePackage,
  type ProviderMeta,
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
  type: "agent" | "provider",
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

describe("makeProviderTool", () => {
  it("produces a {name}_call tool with JSON-schema parameters", () => {
    const meta: ProviderMeta = { name: "@afps/gmail", allowAllUris: true };
    const tool = makeProviderTool(meta, async () => ({
      status: 200,
      headers: {},
      body: { inline: "" },
    }));
    expect(tool.name).toBe("afps_gmail_call");
    expect(tool.description).toContain("@afps/gmail");
    const params = tool.parameters as { required: string[] };
    expect(params.required).toContain("method");
    expect(params.required).toContain("target");
  });

  it("enforces authorizedUris when allowAllUris is not set", async () => {
    const meta: ProviderMeta = {
      name: "@acme/scoped",
      authorizedUris: ["https://api.acme.com/**"],
    };
    const tool = makeProviderTool(meta, async () => ({
      status: 200,
      headers: {},
      body: { inline: "" },
    }));
    const { ctx } = makeCtx();
    await expect(
      tool.execute({ method: "GET", target: "https://evil.example.com/x" }, ctx),
    ).rejects.toThrow(/not in authorizedUris/);
  });

  it("emits provider.called with status + duration on success", async () => {
    const meta: ProviderMeta = { name: "@acme/ok", allowAllUris: true };
    const tool = makeProviderTool(meta, async () => ({
      status: 201,
      headers: {},
      body: { inline: "created" },
    }));
    const { ctx, events } = makeCtx();
    await tool.execute({ method: "POST", target: "https://api.acme.com/x" }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("provider.called");
    expect(events[0]!.status).toBe(201);
    expect(events[0]!.providerId).toBe("@acme/ok");
  });

  it("marks tool results as isError on 4xx/5xx", async () => {
    const meta: ProviderMeta = { name: "@acme/err", allowAllUris: true };
    const tool = makeProviderTool(meta, async () => ({
      status: 404,
      headers: {},
      body: { inline: "nope" },
    }));
    const { ctx } = makeCtx();
    const result = await tool.execute({ method: "GET", target: "https://api.acme.com/x" }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe("SidecarProviderResolver", () => {
  it("POSTs to /proxy with X-Provider + X-Target headers", async () => {
    const calls: RequestInit[] = [];
    const capture = (init?: RequestInit): RequestInit => {
      calls.push(init ?? {});
      return init ?? {};
    };
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@afps/gmail", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        authorizedUris: ["https://gmail.googleapis.com/**"],
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const resolver = new SidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, init: RequestInit) => {
        capture(init);
        return Promise.resolve(
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@afps/gmail", version: "^1" }], bundle);
    expect(tools).toHaveLength(1);
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      { method: "GET", target: "https://gmail.googleapis.com/v1/users/me" },
      ctx,
    );
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers["X-Provider"]).toBe("@afps/gmail");
    expect(headers["X-Target"]).toBe("https://gmail.googleapis.com/v1/users/me");
  });
});

describe("LocalProviderResolver", () => {
  it("substitutes {{field}} placeholders and injects credentials", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@acme/api", "1.0.0", "provider", {
      "provider.json": JSON.stringify({ allowAllUris: true }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const resolver = new LocalProviderResolver({
      creds: {
        version: 1,
        providers: {
          "@acme/api": {
            fields: { api_key: "secret", subdomain: "acme" },
            injection: { headerName: "Authorization", headerPrefix: "Bearer " },
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
    await tools[0]!.execute(
      { method: "GET", target: "https://{{subdomain}}.api.example.com/x" },
      ctx,
    );
    expect(calls[0]!.url).toBe("https://acme.api.example.com/x");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer secret");
  });

  it("fails clearly when no credentials exist for a referenced provider", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root);
    const resolver = new LocalProviderResolver({ creds: { version: 1, providers: {} } });
    await expect(resolver.resolve([{ name: "@missing/x", version: "^1" }], bundle)).rejects.toThrow(
      /no credentials found/,
    );
  });
});

describe("RemoteAppstrateProviderResolver", () => {
  it("POSTs to /api/credential-proxy/proxy with Authorization + X-App-Id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@afps/clickup", "1.0.0", "provider", {
      "provider.json": JSON.stringify({ allowAllUris: true }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const resolver = new RemoteAppstrateProviderResolver({
      instance: "https://app.appstrate.com",
      apiKey: "ask_test",
      appId: "app_1",
      endUserId: "eu_x",
      sessionId: "sess_1",
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@afps/clickup", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute({ method: "GET", target: "https://api.clickup.com/v2/user" }, ctx);

    expect(calls[0]!.url).toBe("https://app.appstrate.com/api/credential-proxy/proxy");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer ask_test");
    expect(h["X-App-Id"]).toBe("app_1");
    expect(h["Appstrate-User"]).toBe("eu_x");
    expect(h["X-Session-Id"]).toBe("sess_1");
    expect(h["X-Provider"]).toBe("@afps/clickup");
    expect(h["X-Target"]).toBe("https://api.clickup.com/v2/user");
  });
});
