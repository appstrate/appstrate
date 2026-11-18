// SPDX-License-Identifier: Apache-2.0

/**
 * The direct path's redirect rules (`_directEgressOptionsForTesting`, `mcp-over-proxy.ts`) under
 * the guard itself, its DNS and transport injected: a redirect to plain http on a host the
 * operator does not trust is refused by the https floor, before anything is sent to it.
 */

import { describe, it, expect } from "bun:test";
import { guardedFetch, SsrfBlockedError } from "@appstrate/core/ssrf";
import { _directEgressOptionsForTesting } from "../../../src/services/credential-proxy/mcp-over-proxy.ts";

/** A public address: the guard's host check passes, so only the https floor can refuse. */
const PUBLIC_IP = "93.184.216.34";

describe("the direct path's redirect rules", () => {
  const follow = async (location: string) => {
    const sent: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      sent.push(String(url));
      return new Response(null, { status: 307, headers: { Location: location } });
    }) as typeof fetch;
    const outcome = await guardedFetch(
      "https://mcp.public.example/mcp",
      { method: "POST", body: "{}" },
      { ..._directEgressOptionsForTesting, resolve: async () => [PUBLIC_IP], fetchImpl },
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    return { outcome, sent };
  };

  it("refuses a redirect to plain http on an untrusted host: blocked-scheme, hop 1", async () => {
    const { outcome, sent } = await follow("http://other.public.example/mcp");
    expect(outcome).toBeInstanceOf(SsrfBlockedError);
    expect(outcome).toMatchObject({ reason: "blocked-scheme", hop: 1 });
    // Only the first hop was sent.
    expect(sent).toEqual(["https://mcp.public.example/mcp"]);
  });

  it("follows a redirect to https on another public host", async () => {
    const { outcome, sent } = await follow("https://other.public.example/mcp");
    expect(sent[1]).toBe("https://other.public.example/mcp");
    // Followed until the guard's own redirect ceiling: no floor refused it.
    expect(outcome).toBeInstanceOf(SsrfBlockedError);
    expect(outcome).toMatchObject({ reason: "too-many-redirects" });
  });
});
