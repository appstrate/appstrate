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
} from "../sidecar/upstream-meta.ts";
import {
  UPSTREAM_META_KEY as RUNTIME_KEY,
  UPSTREAM_HEADER_ALLOWLIST as RUNTIME_ALLOWLIST,
} from "../mcp/upstream-meta.ts";

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
