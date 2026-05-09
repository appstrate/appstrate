// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end defence-in-depth test for the upstream-meta wire format.
 *
 * The constants + types are now shared via `@appstrate/mcp-transport`,
 * so structural parity between the sidecar serializer
 * (`runtime-pi/sidecar/upstream-meta.ts`) and the runtime parser
 * (`runtime-pi/mcp/upstream-meta.ts`) is guaranteed at compile time.
 *
 * What this file still asserts is the END-TO-END filter:
 *   buildUpstreamMeta() → CallToolResult._meta → readUpstreamMeta()
 *
 * Even if the serializer's filter were bypassed (compromised sidecar,
 * future bug), the runtime parser re-applies the allowlist on parse so
 * `set-cookie` / `authorization` etc. cannot leak to the agent.
 */

import { describe, it, expect } from "bun:test";
import { UPSTREAM_META_KEY } from "@appstrate/mcp-transport";
import type { CallToolResult } from "@appstrate/mcp-transport";
import { buildUpstreamMeta } from "../sidecar/upstream-meta.ts";
import { readUpstreamMeta } from "../mcp/upstream-meta.ts";

describe("upstream-meta — sidecar→wire→runtime end-to-end filter", () => {
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
      _meta: { [UPSTREAM_META_KEY]: meta },
    } as never;
    const parsed = readUpstreamMeta(onWire);
    expect(parsed.status).toBe(200);
    expect(parsed.headers.location).toBe("https://api.example.com/upload/abc");
    expect(parsed.headers.etag).toBe('"v1"');
    expect(parsed.headers["content-type"]).toBe("application/json");
    expect(parsed.headers).not.toHaveProperty("set-cookie");
    expect(parsed.headers).not.toHaveProperty("authorization");
    expect(parsed.headers).not.toHaveProperty("www-authenticate");
    expect(parsed.headers).not.toHaveProperty("cookie");
    expect(parsed.headers).not.toHaveProperty("proxy-authorization");
  });

  it("runtime-side parser re-strips sensitive headers a malicious sidecar tried to inject", () => {
    // Simulate a compromised / buggy sidecar that bypassed its own
    // serializer and shipped raw `set-cookie` / `authorization` over
    // the wire. The runtime allowlist must catch it.
    const onWire: CallToolResult = {
      content: [{ type: "text", text: "" }],
      _meta: {
        [UPSTREAM_META_KEY]: {
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
    expect(Object.keys(parsed.headers).sort()).toEqual(["etag", "location"]);
    expect(parsed.headers).not.toHaveProperty("set-cookie");
    expect(parsed.headers).not.toHaveProperty("authorization");
    expect(parsed.headers).not.toHaveProperty("www-authenticate");
    expect(parsed.headers).not.toHaveProperty("cookie");
    expect(parsed.headers).not.toHaveProperty("proxy-authorization");
  });

  it("filter is case-insensitive on the wire (Set-Cookie, SET-COOKIE, etc)", () => {
    const onWire: CallToolResult = {
      content: [{ type: "text", text: "" }],
      _meta: {
        [UPSTREAM_META_KEY]: {
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
    // Only `location` survives; case is normalised to lowercase.
    expect(Object.keys(parsed.headers)).toEqual(["location"]);
  });
});
