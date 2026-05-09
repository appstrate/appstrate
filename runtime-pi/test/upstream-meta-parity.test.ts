// SPDX-License-Identifier: Apache-2.0

/**
 * Parity test for the wire format shared by `runtime-pi/sidecar/upstream-meta.ts`
 * (serializer, runs in the sidecar container) and
 * `runtime-pi/mcp/upstream-meta.ts` (parser, runs in the agent container).
 *
 * The two modules cannot import each other at runtime because they
 * live in different Docker images (sidecar copies only `sidecar/`,
 * runtime copies only `mcp/` + `extensions/`). Test-time parity is
 * the cheapest way to guarantee they agree.
 */

import { describe, it, expect } from "bun:test";
import {
  UPSTREAM_META_KEY as SIDECAR_KEY,
  UPSTREAM_HEADER_ALLOWLIST as SIDECAR_ALLOWLIST,
  buildUpstreamMeta,
} from "../sidecar/upstream-meta.ts";
import {
  UPSTREAM_META_KEY as RUNTIME_KEY,
  UPSTREAM_HEADER_ALLOWLIST as RUNTIME_ALLOWLIST,
  readUpstreamMeta,
} from "../mcp/upstream-meta.ts";
import type { CallToolResult } from "@appstrate/mcp-transport";

describe("upstream-meta wire format parity", () => {
  it("uses the same `_meta` key on both sides", () => {
    expect(SIDECAR_KEY).toBe(RUNTIME_KEY);
  });

  it("uses the same header allowlist on both sides", () => {
    expect([...SIDECAR_ALLOWLIST].sort()).toEqual([...RUNTIME_ALLOWLIST].sort());
  });

  it("allowlist contains every header required by the four upload protocols", () => {
    const required = [
      // Google resumable + Microsoft resumable
      "location",
      "content-range",
      // S3 multipart
      "etag",
      // tus
      "upload-offset",
      "upload-length",
      "tus-resumable",
    ];
    for (const h of required) {
      expect(SIDECAR_ALLOWLIST.has(h)).toBe(true);
      expect(RUNTIME_ALLOWLIST.has(h)).toBe(true);
    }
  });

  it("allowlist excludes credential-bearing headers", () => {
    const excluded = [
      "set-cookie",
      "authorization",
      "www-authenticate",
      "cookie",
      "proxy-authorization",
    ];
    for (const h of excluded) {
      expect(SIDECAR_ALLOWLIST.has(h)).toBe(false);
      expect(RUNTIME_ALLOWLIST.has(h)).toBe(false);
    }
  });
});

describe("upstream-meta — sidecar→wire→runtime end-to-end filter", () => {
  // The static allowlist tests above prove the *constants* match.
  // These tests prove that an actual upstream `Response` carrying
  // sensitive headers is stripped END-TO-END through the chain:
  //   buildUpstreamMeta() → CallToolResult._meta → readUpstreamMeta()
  // Defence-in-depth: the runtime side re-applies the allowlist on
  // parse, so even a compromised sidecar that bypassed the
  // serializer's filter cannot leak `set-cookie` to the agent.

  it("strips set-cookie / authorization at both serializer and parser", () => {
    const upstream = new Response("body", {
      status: 200,
      headers: {
        // Allowlisted — must propagate.
        "Content-Type": "application/json",
        Location: "https://api.example.com/upload/abc",
        ETag: '"v1"',
        // Credential-bearing — must be filtered at *every* hop.
        "Set-Cookie": "session=secret-123; HttpOnly",
        Authorization: "Bearer leaked-token",
        "WWW-Authenticate": 'Bearer realm="upload"',
        Cookie: "csrf=other-secret",
        "Proxy-Authorization": "Basic deadbeef",
      },
    });
    const meta = buildUpstreamMeta(upstream);
    // Sanity: serializer dropped them.
    expect(meta.headers).not.toHaveProperty("set-cookie");
    expect(meta.headers).not.toHaveProperty("authorization");
    expect(meta.headers).not.toHaveProperty("www-authenticate");
    expect(meta.headers).not.toHaveProperty("cookie");
    expect(meta.headers).not.toHaveProperty("proxy-authorization");

    // Now ship through the wire (CallToolResult shape) and parse.
    const onWire: CallToolResult = {
      content: [{ type: "text", text: "body" }],
      _meta: { [SIDECAR_KEY]: meta },
    } as never;
    const parsed = readUpstreamMeta(onWire);
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe(200);
    expect(parsed!.headers.location).toBe("https://api.example.com/upload/abc");
    expect(parsed!.headers.etag).toBe('"v1"');
    expect(parsed!.headers["content-type"]).toBe("application/json");
    expect(parsed!.headers).not.toHaveProperty("set-cookie");
    expect(parsed!.headers).not.toHaveProperty("authorization");
    expect(parsed!.headers).not.toHaveProperty("www-authenticate");
    expect(parsed!.headers).not.toHaveProperty("cookie");
    expect(parsed!.headers).not.toHaveProperty("proxy-authorization");
  });

  it("runtime-side parser re-strips sensitive headers a malicious sidecar tried to inject", () => {
    // Simulate a compromised / buggy sidecar that bypassed its own
    // serializer and shipped raw `set-cookie` / `authorization` over
    // the wire. The runtime allowlist must catch it.
    const onWire: CallToolResult = {
      content: [{ type: "text", text: "" }],
      _meta: {
        [SIDECAR_KEY]: {
          status: 200,
          headers: {
            location: "https://api.example.com/x",
            etag: '"v1"',
            "set-cookie": "session=leaked",
            authorization: "Bearer leaked",
            "www-authenticate": "Bearer",
            cookie: "csrf=leaked",
            "proxy-authorization": "Basic leaked",
          },
        },
      },
    } as never;
    const parsed = readUpstreamMeta(onWire);
    expect(parsed).toBeDefined();
    expect(Object.keys(parsed!.headers).sort()).toEqual(["etag", "location"]);
    expect(parsed!.headers).not.toHaveProperty("set-cookie");
    expect(parsed!.headers).not.toHaveProperty("authorization");
    expect(parsed!.headers).not.toHaveProperty("www-authenticate");
    expect(parsed!.headers).not.toHaveProperty("cookie");
    expect(parsed!.headers).not.toHaveProperty("proxy-authorization");
  });

  it("filter is case-insensitive on the wire (Set-Cookie, SET-COOKIE, etc)", () => {
    const onWire: CallToolResult = {
      content: [{ type: "text", text: "" }],
      _meta: {
        [SIDECAR_KEY]: {
          status: 200,
          headers: {
            // Mixed-case keys from a non-conforming serializer must
            // still be normalised + filtered against the allowlist.
            "Set-Cookie": "session=leaked",
            AUTHORIZATION: "Bearer leaked",
            Location: "https://api.example.com/x",
          },
        },
      },
    } as never;
    const parsed = readUpstreamMeta(onWire);
    expect(parsed).toBeDefined();
    // Only `location` survives; case is normalised to lowercase.
    expect(Object.keys(parsed!.headers)).toEqual(["location"]);
  });
});
