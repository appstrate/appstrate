// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA build's HTTP caching policy.
 *
 * Two halves, and both matter:
 *  - the POLICY (`staticCacheControl`) — `immutable` is only ever correct for a
 *    filename that carries a content hash. Handing it to a stable-named file
 *    (`favicon.ico`, `site.webmanifest`) pins a stale byte stream in every
 *    browser cache for a year with no way to bust it short of a rename, so the
 *    segment test that separates the two classes is a correctness boundary, not
 *    a formatting detail.
 *  - the WIRING — the policy only exists as a header if `index.ts` actually
 *    passes it to the static middleware's `onFound`. Hono's `serveStatic` emits
 *    no `Cache-Control` of its own, so dropping the callback silently restores
 *    "re-download everything, every visit" while every assertion on the pure
 *    function stays green.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  staticCacheControl,
  IMMUTABLE_CACHE_CONTROL,
  SHORT_LIVED_CACHE_CONTROL,
  SPA_HTML_CACHE_CONTROL,
} from "../../src/lib/static-cache.ts";

describe("staticCacheControl", () => {
  it("pins content-hashed build output for a year", () => {
    expect(staticCacheControl("./apps/web/dist/assets/index-DRqZyykT.js")).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
    expect(staticCacheControl("./apps/web/dist/assets/styles-Bh1lwVYD.css")).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
  });

  it("does NOT pin stable-named files — their bytes change under the same URL", () => {
    for (const path of [
      "./apps/web/dist/favicon.ico",
      "./apps/web/dist/site.webmanifest",
      "./apps/web/dist/logo-dark.svg",
      "./apps/web/dist/.well-known/apple-app-site-association",
    ]) {
      expect(staticCacheControl(path)).toBe(SHORT_LIVED_CACHE_CONTROL);
    }
  });

  it("matches `assets` as a whole path segment, not as a substring", () => {
    // Neither of these is Vite build output; a substring test would pin both.
    expect(staticCacheControl("./apps/web/dist/my-assets/logo.svg")).toBe(
      SHORT_LIVED_CACHE_CONTROL,
    );
    expect(staticCacheControl("./apps/web/dist/assets.js")).toBe(SHORT_LIVED_CACHE_CONTROL);
  });

  it("is root-prefix agnostic and separator agnostic", () => {
    expect(staticCacheControl("assets/index-abc.js")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl("/srv/app/apps/web/dist/assets/index-abc.js")).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
    expect(staticCacheControl(String.raw`apps\web\dist\assets\index-abc.js`)).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
  });

  it("declares a year for immutable output and a revalidating SPA document", () => {
    // The two values that would be actively harmful if they drifted into each
    // other: a year on the shell, or `immutable` on anything revalidatable.
    expect(IMMUTABLE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(SPA_HTML_CACHE_CONTROL).toBe("no-cache");
    expect(SHORT_LIVED_CACHE_CONTROL).not.toContain("immutable");
  });
});

/**
 * Production wiring, read out of the source for the same reason
 * `spa-csp.test.ts` does it: importing `index.ts` boots a real server.
 */
const INDEX_TS = readFileSync(
  fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
  "utf-8",
);

describe("static-asset cache wiring in index.ts", () => {
  it("hands every served file to the cache policy via onFound", () => {
    expect(INDEX_TS).toContain(`import { staticCacheControl } from "./lib/static-cache.ts"`);
    expect(INDEX_TS).toMatch(
      /onFound:\s*\(path, c\) => \{\s*c\.header\("Cache-Control", staticCacheControl\(path\)\);/,
    );
  });
});
