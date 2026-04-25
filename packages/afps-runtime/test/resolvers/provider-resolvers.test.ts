// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  makeProviderTool,
  matchesAuthorizedUriSpec,
  readProviderMeta,
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
      body: { kind: "text", text: "", truncated: false },
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
      body: { kind: "text", text: "", truncated: false },
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
      body: { kind: "text", text: "created", truncated: false },
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
      body: { kind: "text", text: "nope", truncated: false },
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
        definition: { authorizedUris: ["https://gmail.googleapis.com/**"] },
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
      "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
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
      "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
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

describe("readProviderMeta", () => {
  // Canonical AFPS shape (spec §7.5 / §8.6): authorizedUris + allowAllUris
  // live under definition.*. Provider.json producers use this shape (all
  // the shipped system packages do), and readProviderMeta is the choke
  // point every resolver funnels through. Regressing this breaks every
  // authenticated provider call at runtime.
  it("projects authorizedUris + allowAllUris from manifest.definition.*", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@afps/gmail", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        name: "@afps/gmail",
        definition: {
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          allowAllUris: false,
        },
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const meta = readProviderMeta(bundle, { name: "@afps/gmail", version: "^1" }, false);
    expect(meta.name).toBe("@afps/gmail");
    expect(meta.authorizedUris).toEqual(["https://gmail.googleapis.com/**"]);
    expect(meta.allowAllUris).toBe(false);
  });

  it("ignores top-level authorizedUris — definition.* is the only source", () => {
    // A manifest with auth fields at the top level is malformed per the
    // AFPS spec. readProviderMeta must not silently rescue it; otherwise
    // producers shipping broken manifests go undetected.
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        authorizedUris: ["https://api.acme.com/**"],
        allowAllUris: false,
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const meta = readProviderMeta(bundle, { name: "@acme/p", version: "^1" }, false);
    expect(meta.authorizedUris).toBeUndefined();
    expect(meta.allowAllUris).toBeUndefined();
  });

  it("falls back to the in-memory pkg.manifest when no provider.json/manifest.json file exists", () => {
    // Edge case: the bundle builder gives us a parsed manifest even when
    // the original ZIP had no manifest file. The projection must work
    // from that in-memory object too.
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg: BundlePackage = {
      identity: "@acme/p@1.0.0" as const,
      manifest: {
        name: "@acme/p",
        version: "1.0.0",
        type: "provider",
        definition: { allowAllUris: true },
      },
      files: new Map(),
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const bundle = makeBundle(root, [providerPkg]);
    const meta = readProviderMeta(bundle, { name: "@acme/p", version: "^1" }, false);
    expect(meta.allowAllUris).toBe(true);
  });

  it("returns the explicit allowAllUris fallback when the package is absent", () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const bundle = makeBundle(root);
    const sidecarMeta = readProviderMeta(bundle, { name: "@missing/p", version: "^1" }, true);
    expect(sidecarMeta.allowAllUris).toBe(true);
    const localMeta = readProviderMeta(bundle, { name: "@missing/p", version: "^1" }, false);
    expect(localMeta.allowAllUris).toBe(false);
  });
});

describe("matchesAuthorizedUriSpec", () => {
  // Semantic contract: `*` = single path segment, `**` = any substring.
  // All shipped system-package manifests now use `/**` for prefix match;
  // the invariants below are what enables multi-segment API targets
  // (e.g. `/gmail/v1/users/me/messages`) to reach upstream.
  it("** matches any path suffix including multi-segment and query", () => {
    const pat = "https://gmail.googleapis.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/v1")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/gmail/v1/users/me")).toBe(
      true,
    );
    expect(
      matchesAuthorizedUriSpec(
        pat,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      ),
    ).toBe(true);
  });

  it("* matches a single path segment only — does not cross slashes", () => {
    const pat = "https://api.acme.com/*";
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users/42")).toBe(false);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/")).toBe(true);
  });

  it("anchors the pattern — prefix-only matches are rejected", () => {
    // Guards against the regex accidentally degenerating to an unanchored
    // substring test, which would let `https://api.acme.com/**` match
    // `https://evil.com/?x=https://api.acme.com/anything`.
    expect(
      matchesAuthorizedUriSpec(
        "https://api.acme.com/**",
        "https://evil.com/?x=https://api.acme.com/anything",
      ),
    ).toBe(false);
  });

  it("escapes regex metacharacters in the pattern so they cannot inject", () => {
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://apiXacmeXcom/xXy")).toBe(
      false,
    );
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://api.acme.com/x.y")).toBe(
      true,
    );
  });

  it("subdomain wildcards stay single-segment and reject host smuggling", () => {
    // `*.acme.com/**` must match `x.acme.com/path/anything` but reject
    // `evil.com/x.acme.com/path` — `*` in host position cannot bridge a
    // `/` either.
    const pat = "https://*.acme.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://eu.acme.com/v1/users/42")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x.acme.com/y")).toBe(false);
  });
});

describe("SidecarProviderResolver — wire protocol is credential-free", () => {
  // Option C (issue #250) moved credential injection server-side. The
  // sidecar now owns the injection — the runtime forwards only
  // routing headers (`X-Provider`, `X-Target`) plus any custom headers
  // the LLM explicitly set. No Authorization, no placeholders, no
  // credential field at all on the wire from agent to sidecar.
  it("forwards only routing headers — no auth metadata leaks from the manifest", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@appstrate/gmail", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        definition: {
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);

    const calls: RequestInit[] = [];
    const resolver = new SidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@appstrate/gmail", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      { method: "GET", target: "https://gmail.googleapis.com/gmail/v1/users/me" },
      ctx,
    );
    const h = calls[0]!.headers as Record<string, string>;
    expect(h["X-Provider"]).toBe("@appstrate/gmail");
    expect(h["X-Target"]).toBe("https://gmail.googleapis.com/gmail/v1/users/me");
    // The canonical Option C guarantee: the credential header never
    // crosses the agent → sidecar boundary. The sidecar writes it
    // server-side from the platform's internal credentials payload.
    expect(h.Authorization).toBeUndefined();
    expect(h.authorization).toBeUndefined();
  });

  it("passes caller-supplied headers through untouched for agent-driven overrides", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@appstrate/gmail", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        definition: {
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);
    const calls: RequestInit[] = [];
    const resolver = new SidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@appstrate/gmail", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    await tools[0]!.execute(
      {
        method: "GET",
        target: "https://gmail.googleapis.com/gmail/v1/users/me",
        headers: { "X-Dual-Auth-Token": "agent-override" },
      },
      ctx,
    );
    const h = calls[0]!.headers as Record<string, string>;
    // Custom headers pass through to the sidecar, which then honours
    // them over the server-side injection for non-Authorization
    // keys — preserves dual-auth / exotic flows without giving up the
    // pinned-header guarantee for the 99% default.
    expect(h["X-Dual-Auth-Token"]).toBe("agent-override");
  });
});

describe("SidecarProviderResolver — end-to-end enforcement on a multi-segment target", () => {
  // Integration guard that reproduces the exact regression we just fixed:
  // manifest with nested definition.authorizedUris + a realistic target
  // URL that has more than one path segment below the host. If either
  // readProviderMeta's projection or the /** matcher semantics regress,
  // this test fails before the container run does.
  it("accepts a multi-segment upstream call when definition.authorizedUris matches /**", async () => {
    const root = makePackage("@acme/agent", "1.0.0", "agent", {});
    const providerPkg = makePackage("@appstrate/gmail", "1.0.0", "provider", {
      "provider.json": JSON.stringify({
        name: "@appstrate/gmail",
        definition: {
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      }),
    });
    const bundle = makeBundle(root, [providerPkg]);

    const calls: RequestInit[] = [];
    const resolver = new SidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@appstrate/gmail", version: "^1" }], bundle);
    const { ctx } = makeCtx();
    const res = await tools[0]!.execute(
      {
        method: "GET",
        target: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
