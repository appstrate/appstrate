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
  it("inserts the well-known segment between host and path", () => {
    expect(buildProtectedResourceProbes("https://mcp.clickup.com/mcp")).toEqual([
      "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.clickup.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("dedupes for a root resource URL", () => {
    expect(buildProtectedResourceProbes("https://mcp.example.com")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
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

  it("resolves via the well-known probe", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return jsonResponse(valid);
    }) as unknown as typeof fetch;

    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.clickup.com/mcp",
      fetchImpl,
    });
    expect(md).not.toBeNull();
    expect(md!.resource).toBe("https://mcp.clickup.com");
    expect(md!.authorizationServers).toEqual(["https://mcp.clickup.com"]);
    expect(md!.scopesSupported).toEqual(["read", "write"]);
    expect(seen[0]).toBe("https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp");
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

  it("falls back to the 401 WWW-Authenticate challenge", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes(".well-known")) return new Response("nope", { status: 404 });
      if (url === "https://mcp.x.com/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.x.com/meta"',
          },
        });
      }
      if (url === "https://mcp.x.com/meta") return jsonResponse(valid);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: "https://mcp.x.com/mcp",
      fetchImpl,
    });
    expect(md).not.toBeNull();
    expect(md!.resource).toBe("https://mcp.clickup.com");
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
