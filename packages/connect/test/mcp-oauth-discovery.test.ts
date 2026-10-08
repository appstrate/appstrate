// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildProtectedResourceProbes,
  parseResourceMetadataChallenge,
  discoverProtectedResourceMetadata,
} from "../src/mcp-oauth-discovery.ts";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildProtectedResourceProbes (RFC 9728 §3)", () => {
  it("inserts the well-known segment between host and path, then the root location", () => {
    expect(buildProtectedResourceProbes("https://mcp.clickup.com/mcp")).toEqual([
      {
        metadataUrl: "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp",
        resource: "https://mcp.clickup.com/mcp",
      },
      {
        metadataUrl: "https://mcp.clickup.com/.well-known/oauth-protected-resource",
        resource: "https://mcp.clickup.com",
      },
    ]);
  });

  it("has one location for a root resource URL", () => {
    expect(buildProtectedResourceProbes("https://mcp.example.com")).toEqual([
      {
        metadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
        resource: "https://mcp.example.com",
      },
    ]);
  });

  it("returns [] for a malformed URL", () => {
    expect(buildProtectedResourceProbes("not a url")).toEqual([]);
  });
});

describe("parseResourceMetadataChallenge (RFC 9728 §5.1)", () => {
  it("extracts resource_metadata from a WWW-Authenticate challenge", () => {
    const header =
      'Bearer realm="MCP Server", error="invalid_token", resource_metadata="https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp"';
    expect(parseResourceMetadataChallenge(header)).toBe(
      "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("returns undefined when absent", () => {
    expect(parseResourceMetadataChallenge('Bearer realm="x"')).toBeUndefined();
  });
});

describe("discoverProtectedResourceMetadata", () => {
  const valid = {
    resource: "https://mcp.clickup.com",
    authorization_servers: ["https://mcp.clickup.com"],
    scopes_supported: ["read", "write"],
  };

  it("asks the resource first, then the path-inserted location, then the root one", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return jsonResponse(valid);
    }) as unknown as typeof fetch;

    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.clickup.com/mcp",
      fetchImpl,
    });
    // The path-inserted document names the origin, not `/mcp`: skipped. The root one names the
    // origin, the identifier the root location is derived from: used.
    expect(md).not.toBeNull();
    expect(md!.resource).toBe("https://mcp.clickup.com");
    expect(md!.authorizationServers).toEqual(["https://mcp.clickup.com"]);
    expect(md!.scopesSupported).toEqual(["read", "write"]);
    expect(seen).toEqual([
      "https://mcp.clickup.com/mcp",
      "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.clickup.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("uses a path-inserted document whose resource is the resource URL (trailing / aside)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url === "https://forge.example.com/.well-known/oauth-protected-resource/api/v4/mcp") {
        return jsonResponse({
          resource: "https://forge.example.com/api/v4/mcp/",
          authorization_servers: ["https://forge.example.com"],
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://forge.example.com/api/v4/mcp",
      fetchImpl,
    });
    expect(md!.resource).toBe("https://forge.example.com/api/v4/mcp/");
    expect(seen).not.toContain("https://forge.example.com/.well-known/oauth-protected-resource");
  });

  it("skips a root document naming a deeper resource, and refuses when nothing else qualifies", async () => {
    // gitlab.com's root location advertises `…/api/v4/mcp`: not the origin it is derived from.
    const fetchImpl = (async (url: string) => {
      if (url === "https://forge.example.com/.well-known/oauth-protected-resource") {
        return jsonResponse({
          resource: "https://forge.example.com/api/v4/mcp",
          authorization_servers: ["https://forge.example.com"],
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://forge.example.com/api/v4/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("refuses a path-inserted document for another path of the same origin", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/oauth-protected-resource/mcp")
        ? jsonResponse({
            resource: "https://mcp.x.com/other",
            authorization_servers: ["https://mcp.x.com"],
          })
        : new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.x.com/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("prefers an explicit resourceMetadataUrl", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return jsonResponse(valid);
    }) as unknown as typeof fetch;

    await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.clickup.com/mcp",
      resourceMetadataUrl: "https://explicit/meta",
      fetchImpl,
    });
    expect(seen[0]).toBe("https://explicit/meta");
  });

  it("uses the 401 WWW-Authenticate challenge before the well-known locations", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url === "https://mcp.x.com/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.x.com/meta"',
          },
        });
      }
      // RFC 9728 §3.3: a challenge's document describes the URL that was challenged.
      if (url === "https://mcp.x.com/meta") {
        return jsonResponse({
          resource: "https://mcp.x.com/mcp",
          authorization_servers: ["https://as.mcp.x.com"],
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.x.com/mcp",
      fetchImpl,
    });
    expect(md).not.toBeNull();
    expect(md!.resource).toBe("https://mcp.x.com/mcp");
    expect(seen).toEqual(["https://mcp.x.com/mcp", "https://mcp.x.com/meta"]);
  });

  it("skips a challenge document naming the origin rather than the challenged URL", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://mcp.x.com/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.x.com/meta"' },
        });
      }
      if (url === "https://mcp.x.com/meta") {
        return jsonResponse({
          resource: "https://mcp.x.com",
          authorization_servers: ["https://as.mcp.x.com"],
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    expect(
      await discoverProtectedResourceMetadata({
        resourceServerUrl: "https://mcp.x.com/mcp",
        fetchImpl,
      }),
    ).toBeNull();
  });

  it("rejects metadata whose resource origin differs from the resource server (RFC 9728 §3.3)", async () => {
    // A hostile/misconfigured document that binds the token audience to an
    // unrelated origin must not be accepted, even when otherwise well-formed.
    const fetchImpl = (async () => jsonResponse(valid)) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.evil.example/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("rejects a non-http(s) resource server URL", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(valid);
    }) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "file:///etc/passwd",
      fetchImpl,
    });
    expect(md).toBeNull();
    expect(calls).toBe(0);
  });

  it("rejects metadata without authorization_servers", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ resource: "https://x" })) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://x/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("refuses a metadata document larger than 64 KiB", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        resource: "https://x/mcp",
        authorization_servers: ["https://as.x"],
        padding: "x".repeat(64 * 1024),
      })) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://x/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("returns null when no strategy yields a document", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://x/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
  });

  it("degrades to null when the (SSRF-guarded) fetch throws on every probe", async () => {
    // The orchestrator injects an SSRF-guarded fetch that throws on blocked
    // targets. Discovery must swallow that and return null (no client minted)
    // rather than propagating — a blocked URL becomes "discovery failed".
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("SSRF guard: refusing to fetch blocked URL");
    }) as unknown as typeof fetch;
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://blocked.internal/mcp",
      fetchImpl,
    });
    expect(md).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });
});
