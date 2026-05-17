// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the RFC 9728 / RFC 8414 discovery cascade. All
 * network access is injected via the `fetchJson` boundary so these
 * tests run without hitting real AS endpoints.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  discoverEndpoints,
  selectAuthorizationServer,
  buildAsMetadataUrl,
  clearDiscoveryCache,
  DiscoveryError,
} from "../src/oauth-discovery.ts";

const PRM_URL = "https://api.example.com/.well-known/oauth-protected-resource";

function recordingFetcher(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (!(url in responses)) {
      throw new Error(`Unstubbed URL: ${url}`);
    }
    return responses[url];
  };
  return { fn, calls };
}

beforeEach(() => clearDiscoveryCache());

describe("buildAsMetadataUrl", () => {
  it("uses RFC 8414 §3.1 root path when issuer path is /", () => {
    expect(buildAsMetadataUrl("https://issuer.example.com")).toBe(
      "https://issuer.example.com/.well-known/oauth-authorization-server",
    );
    expect(buildAsMetadataUrl("https://issuer.example.com/")).toBe(
      "https://issuer.example.com/.well-known/oauth-authorization-server",
    );
  });

  it("preserves issuer subpath per RFC 8414 §3.1", () => {
    expect(buildAsMetadataUrl("https://issuer.example.com/tenant1")).toBe(
      "https://issuer.example.com/.well-known/oauth-authorization-server/tenant1",
    );
  });

  it("strips trailing slash from issuer subpath", () => {
    expect(buildAsMetadataUrl("https://issuer.example.com/tenant1/")).toBe(
      "https://issuer.example.com/.well-known/oauth-authorization-server/tenant1",
    );
  });
});

describe("selectAuthorizationServer", () => {
  it("returns the first candidate when no allowlist is given", () => {
    expect(selectAuthorizationServer(["https://a", "https://b"], [])).toBe("https://a");
  });

  it("matches the first candidate that is in the allowlist", () => {
    expect(
      selectAuthorizationServer(["https://rogue", "https://trusted"], ["https://trusted"]),
    ).toBe("https://trusted");
  });

  it("throws NO_ALLOWED_ISSUER when no candidate matches the allowlist", () => {
    try {
      selectAuthorizationServer(["https://rogue"], ["https://trusted"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("NO_ALLOWED_ISSUER");
    }
  });
});

describe("discoverEndpoints — single AS happy path", () => {
  it("walks PRM → AS metadata and returns the resolved endpoints", async () => {
    const { fn, calls } = recordingFetcher({
      [PRM_URL]: {
        resource: "https://api.example.com",
        authorization_servers: ["https://issuer.example.com"],
      },
      "https://issuer.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://issuer.example.com",
        authorization_endpoint: "https://issuer.example.com/authorize",
        token_endpoint: "https://issuer.example.com/token",
        revocation_endpoint: "https://issuer.example.com/revoke",
      },
    });

    const out = await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      fetchJson: fn,
    });
    expect(out).toEqual({
      authorizationUrl: "https://issuer.example.com/authorize",
      tokenUrl: "https://issuer.example.com/token",
      refreshUrl: "https://issuer.example.com/token", // falls back to token endpoint
      revokeUrl: "https://issuer.example.com/revoke",
      issuer: "https://issuer.example.com",
    });
    expect(calls).toEqual([
      PRM_URL,
      "https://issuer.example.com/.well-known/oauth-authorization-server",
    ]);
  });

  it("prefers refresh_endpoint when present", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: { resource: "x", authorization_servers: ["https://i"] },
      "https://i/.well-known/oauth-authorization-server": {
        issuer: "https://i",
        authorization_endpoint: "https://i/a",
        token_endpoint: "https://i/t",
        refresh_endpoint: "https://i/r",
      },
    });
    const out = await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
    expect(out.refreshUrl).toBe("https://i/r");
  });
});

describe("discoverEndpoints — multi-AS with allowlist", () => {
  it("picks the allowlisted issuer regardless of order", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: {
        resource: "x",
        authorization_servers: ["https://rogue", "https://trusted"],
      },
      "https://trusted/.well-known/oauth-authorization-server": {
        issuer: "https://trusted",
        authorization_endpoint: "https://trusted/a",
        token_endpoint: "https://trusted/t",
      },
    });
    const out = await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      allowedIssuers: ["https://trusted"],
      fetchJson: fn,
    });
    expect(out.issuer).toBe("https://trusted");
  });

  it("fails NO_ALLOWED_ISSUER when none of the advertised servers are allowed", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: {
        resource: "x",
        authorization_servers: ["https://rogue1", "https://rogue2"],
      },
    });
    try {
      await discoverEndpoints({
        protectedResourceMetadataUrl: PRM_URL,
        allowedIssuers: ["https://trusted"],
        fetchJson: fn,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("NO_ALLOWED_ISSUER");
    }
  });
});

describe("discoverEndpoints — SSRF / malformed URL", () => {
  it("blocks loopback discovery URLs", async () => {
    try {
      await discoverEndpoints({
        protectedResourceMetadataUrl: "http://127.0.0.1/.well-known/oauth-protected-resource",
        fetchJson: async () => ({}),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("BLOCKED_URL");
    }
  });

  it("blocks AWS metadata IP", async () => {
    try {
      await discoverEndpoints({
        protectedResourceMetadataUrl: "http://169.254.169.254/.well-known/oauth-protected-resource",
        fetchJson: async () => ({}),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("BLOCKED_URL");
    }
  });

  it("blocks the AS metadata URL when the issuer points at a private network", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: {
        resource: "x",
        authorization_servers: ["http://10.0.0.5"],
      },
    });
    try {
      await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("BLOCKED_URL");
    }
  });

  it("blocks non-https schemes", async () => {
    try {
      await discoverEndpoints({
        protectedResourceMetadataUrl: "ftp://example.com/.well-known/oauth-protected-resource",
        fetchJson: async () => ({}),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("BLOCKED_URL");
    }
  });
});

describe("discoverEndpoints — invalid metadata", () => {
  it("rejects PRM missing the `resource` field", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: { authorization_servers: ["https://i"] },
    });
    try {
      await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DiscoveryError).code).toBe("INVALID_METADATA");
    }
  });

  it("rejects PRM with empty authorization_servers", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: { resource: "x", authorization_servers: [] },
    });
    try {
      await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DiscoveryError).code).toBe("INVALID_METADATA");
    }
  });

  it("rejects AS metadata missing token_endpoint", async () => {
    const { fn } = recordingFetcher({
      [PRM_URL]: { resource: "x", authorization_servers: ["https://i"] },
      "https://i/.well-known/oauth-authorization-server": {
        issuer: "https://i",
        authorization_endpoint: "https://i/a",
      },
    });
    try {
      await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DiscoveryError).code).toBe("INCOMPLETE_AS_METADATA");
    }
  });
});

describe("discoverEndpoints — cache TTL", () => {
  it("returns the cached entry on a second call within TTL", async () => {
    let now = 1_000_000;
    const responses = {
      [PRM_URL]: { resource: "x", authorization_servers: ["https://i"] },
      "https://i/.well-known/oauth-authorization-server": {
        issuer: "https://i",
        authorization_endpoint: "https://i/a",
        token_endpoint: "https://i/t",
      },
    };
    const { fn, calls } = recordingFetcher(responses);

    await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      fetchJson: fn,
      now: () => now,
    });
    expect(calls.length).toBe(2);

    now += 1000; // still within default TTL
    await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      fetchJson: fn,
      now: () => now,
    });
    expect(calls.length).toBe(2); // no new calls

    now += 25 * 60 * 60 * 1000; // past 24h TTL
    await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      fetchJson: fn,
      now: () => now,
    });
    expect(calls.length).toBe(4); // re-fetched both PRM and AS
  });

  it("treats different allowedIssuers as distinct cache keys", async () => {
    const responses = {
      [PRM_URL]: { resource: "x", authorization_servers: ["https://a", "https://b"] },
      "https://a/.well-known/oauth-authorization-server": {
        issuer: "https://a",
        authorization_endpoint: "https://a/a",
        token_endpoint: "https://a/t",
      },
      "https://b/.well-known/oauth-authorization-server": {
        issuer: "https://b",
        authorization_endpoint: "https://b/a",
        token_endpoint: "https://b/t",
      },
    };
    const { fn } = recordingFetcher(responses);

    const r1 = await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      allowedIssuers: ["https://a"],
      fetchJson: fn,
    });
    const r2 = await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      allowedIssuers: ["https://b"],
      fetchJson: fn,
    });
    expect(r1.issuer).toBe("https://a");
    expect(r2.issuer).toBe("https://b");
  });

  it("respects skipCache for fresh reads but still writes the cache", async () => {
    let calls = 0;
    const fn = async (url: string) => {
      calls++;
      if (url === PRM_URL) {
        return { resource: "x", authorization_servers: ["https://i"] };
      }
      return {
        issuer: "https://i",
        authorization_endpoint: "https://i/a",
        token_endpoint: "https://i/t",
      };
    };
    await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
    const before = calls;
    await discoverEndpoints({
      protectedResourceMetadataUrl: PRM_URL,
      fetchJson: fn,
      skipCache: true,
    });
    expect(calls).toBeGreaterThan(before);
  });
});

describe("discoverEndpoints — fetch failure surface", () => {
  it("wraps fetch errors in DiscoveryError(FETCH_FAILED)", async () => {
    const fn = async () => {
      throw new Error("ENOTFOUND");
    };
    try {
      await discoverEndpoints({ protectedResourceMetadataUrl: PRM_URL, fetchJson: fn });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe("FETCH_FAILED");
      expect((err as DiscoveryError).message).toContain("ENOTFOUND");
    }
  });
});
