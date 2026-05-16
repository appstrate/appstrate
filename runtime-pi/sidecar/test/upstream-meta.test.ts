// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  UPSTREAM_HEADER_ALLOWLIST,
  buildUpstreamMeta,
  projectAllowedHeaders,
} from "../upstream-meta.ts";

describe("upstream-meta — header projection", () => {
  it("keeps allowlisted headers, strips everything else", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Location: "https://example.com/upload/abc",
      ETag: '"abc-1"',
      "Set-Cookie": "session=secret",
      Authorization: "Bearer leaked",
      "X-Custom": "irrelevant",
    });
    const projected = projectAllowedHeaders(headers);
    expect(projected).toEqual({
      "content-type": "application/json",
      location: "https://example.com/upload/abc",
      etag: '"abc-1"',
    });
  });

  it("lowercases keys for stable consumer-side reads", () => {
    const headers = new Headers({
      ETAG: '"x"',
      "CONTENT-TYPE": "text/plain",
    });
    const projected = projectAllowedHeaders(headers);
    expect(Object.keys(projected).sort()).toEqual(["content-type", "etag"]);
  });

  it("returns an empty object when no header matches", () => {
    const headers = new Headers({ "X-Foo": "1", "X-Bar": "2" });
    expect(projectAllowedHeaders(headers)).toEqual({});
  });
});

describe("upstream-meta — buildUpstreamMeta", () => {
  it("captures upstream status + allowlisted headers from a Response", () => {
    const res = new Response("body", {
      status: 308,
      headers: {
        Location: "https://example.com/x",
        "Set-Cookie": "session=secret", // must NOT propagate
      },
    });
    const meta = buildUpstreamMeta(res);
    expect(meta.status).toBe(308);
    expect(meta.headers.location).toBe("https://example.com/x");
    expect(Object.keys(meta.headers)).not.toContain("set-cookie");
  });

  it("does not consume the Response body (preserves bytes for content[])", async () => {
    const res = new Response("xyz", { status: 200 });
    const meta = buildUpstreamMeta(res);
    expect(meta.status).toBe(200);
    // Body still readable.
    expect(await res.text()).toBe("xyz");
  });

  it("preserves error-status responses (4xx/5xx)", () => {
    const res = new Response("nope", { status: 404, headers: { "Content-Type": "text/plain" } });
    const meta = buildUpstreamMeta(res);
    expect(meta.status).toBe(404);
    expect(meta.headers["content-type"]).toBe("text/plain");
  });
});

describe("upstream-meta — finalUrl sanitization (#471)", () => {
  it("omits finalUrl when not supplied (preflight / non-attaching paths)", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res);
    expect(meta.finalUrl).toBeUndefined();
    expect("finalUrl" in meta).toBe(false);
  });

  it("passes a clean URL through verbatim", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://api.example.com/callback?code=ABC&state=xyz");
    expect(meta.finalUrl).toBe("https://api.example.com/callback?code=ABC&state=xyz");
  });

  it("strips userinfo (basic-auth credentials in URL)", () => {
    // Mirrors WHATWG Fetch Response.url: never leak `user:pass@`.
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://user:secret@api.example.com/p?q=1");
    expect(meta.finalUrl).toBe("https://api.example.com/p?q=1");
    expect(meta.finalUrl).not.toContain("user");
    expect(meta.finalUrl).not.toContain("secret");
  });

  it("strips username-only userinfo", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://onlyuser@api.example.com/");
    expect(meta.finalUrl).toBe("https://api.example.com/");
  });

  it("strips fragment (`#…`)", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://api.example.com/p?q=1#access_token=leak");
    expect(meta.finalUrl).toBe("https://api.example.com/p?q=1");
  });

  it("strips both userinfo and fragment together", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://u:p@api.example.com/cb?code=ABC#token=Y");
    expect(meta.finalUrl).toBe("https://api.example.com/cb?code=ABC");
  });

  it("preserves query string (callback codes / tickets live there)", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://api.example.com/signin?code=ABC123&state=xyz");
    expect(meta.finalUrl).toContain("code=ABC123");
    expect(meta.finalUrl).toContain("state=xyz");
  });

  it("omits finalUrl when input is unparseable (defence against malformed Location)", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "not://a valid url!! ");
    expect(meta.finalUrl).toBeUndefined();
    expect("finalUrl" in meta).toBe(false);
  });

  it("preserves non-standard ports", () => {
    const res = new Response(null, { status: 200 });
    const meta = buildUpstreamMeta(res, "https://api.example.com:8443/cb?code=X");
    expect(meta.finalUrl).toBe("https://api.example.com:8443/cb?code=X");
  });
});

describe("upstream-meta — allowlist sanity", () => {
  it("includes every header required by the four upload protocols", () => {
    const required = [
      "location",
      "content-range",
      "etag",
      "upload-offset",
      "upload-length",
      "tus-resumable",
      "x-amz-version-id",
    ];
    for (const h of required) {
      expect(UPSTREAM_HEADER_ALLOWLIST.has(h)).toBe(true);
    }
  });

  it("excludes credential-bearing and authentication headers", () => {
    const excluded = ["set-cookie", "authorization", "www-authenticate", "cookie"];
    for (const h of excluded) {
      expect(UPSTREAM_HEADER_ALLOWLIST.has(h)).toBe(false);
    }
  });
});
