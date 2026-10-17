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
 *  - the WIRING — the policy only exists as a header if the static middleware
 *    hands every file it serves to it. Hono's `serveStatic` emits no
 *    `Cache-Control` and no `ETag` of its own, so a dropped callback silently
 *    restores "re-download everything, every visit" while every assertion on
 *    the pure function stays green. `serveSpaBuild` is therefore exercised with
 *    real requests over a build directory, and `index.ts` is held to mounting it.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  serveSpaBuild,
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
  it("serves the SPA build through serveSpaBuild", () => {
    expect(INDEX_TS).toContain(`import { serveSpaBuild } from "./lib/static-cache.ts"`);
    expect(INDEX_TS).toContain(`serveSpaBuild(app, "./apps/web/dist");`);
    expect(INDEX_TS).not.toContain("serveStatic(");
  });
});

describe("serveSpaBuild", () => {
  const DATA = '{"emojis":["🚜"]}';
  let root: string;
  let app: Hono;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "spa-build-"));
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, "emojibase", "fr"), { recursive: true });
    writeFileSync(join(root, "assets", "index-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "favicon.ico"), "ico");
    writeFileSync(join(root, "emojibase", "fr", "data.json"), DATA);
    app = new Hono();
    serveSpaBuild(app, root);
    app.get("/*", (c) => c.text("spa fallback"));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("pins a content-hashed asset and gives it no validator", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("gives a stable-named file the short TTL", async () => {
    const res = await app.request("/favicon.ico");
    expect(res.headers.get("Cache-Control")).toBe(SHORT_LIVED_CACHE_CONTROL);
  });

  it("serves the Emojibase dataset with an ETag, revalidated with a 304", async () => {
    const res = await app.request("/emojibase/fr/data.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DATA);
    expect(res.headers.get("Content-Type")).toStartWith("application/json");
    expect(res.headers.get("Cache-Control")).toBe(SHORT_LIVED_CACHE_CONTROL);
    const tag = res.headers.get("ETag");
    expect(tag).toMatch(/^"[0-9a-f]+"$/);

    // Frimousse revalidates with a HEAD and compares the tag.
    const head = await app.request("/emojibase/fr/data.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(tag);
    expect(await head.text()).toBe("");

    const again = await app.request("/emojibase/fr/data.json", {
      headers: { "If-None-Match": tag! },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(tag);
    expect(again.headers.get("Cache-Control")).toBe(SHORT_LIVED_CACHE_CONTROL);
    expect(await again.text()).toBe("");

    const stale = await app.request("/emojibase/fr/data.json", {
      headers: { "If-None-Match": '"0000"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(DATA);
  });

  it("changes the ETag when the bytes change", async () => {
    const before = (await app.request("/emojibase/fr/data.json")).headers.get("ETag");
    writeFileSync(join(root, "emojibase", "fr", "data.json"), '{"emojis":[]}');
    const after = (await app.request("/emojibase/fr/data.json")).headers.get("ETag");
    writeFileSync(join(root, "emojibase", "fr", "data.json"), DATA);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("leaves the SPA document to the fallback", async () => {
    for (const path of ["/", "/index.html", "/some/page"]) {
      const res = await app.request(path);
      expect(await res.text()).toBe("spa fallback");
    }
  });
});
