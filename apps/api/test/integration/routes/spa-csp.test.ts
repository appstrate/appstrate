// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the SPA document's `Content-Security-Policy`.
 *
 * The SPA shell is the PARENT document of the agent-HTML preview iframe, and its
 * `frame-src` is the only place the preview frame's cross-origin NAVIGATION can
 * be bounded: the preview response's own CSP `sandbox allow-scripts` cannot stop
 * the frame navigating ITSELF, and navigation is not covered by `connect-src` or
 * `form-action`. Measured in Chrome against this exact header — a sandboxed
 * child's attempt to navigate itself to an origin outside `frame-src` is blocked
 * with no network request to the target, while its legitimate initial load still
 * succeeds. (Navigation is all it bounds; exfiltration in general is not closed —
 * see the WebRTC/STUN residual in `services/document-preview.ts`.)
 *
 * Three things are pinned here, and the last two matter as much as the first:
 *  - the header is present, and its single origin tracks `USERCONTENT_URL`;
 *  - the header carries `frame-src` and NOTHING ELSE. A full SPA CSP would break
 *    the Vite build's inline bootstrapping, so a `script-src` (or any other
 *    directive) appearing next to `frame-src` is a real breakage, not a
 *    tightening;
 *  - the handler is actually MOUNTED in `index.ts`. Every assertion above runs
 *    against a locally-mounted handler, so on its own the suite stays green if
 *    production reverts to the old inline `app.get("/*", …)` and the header
 *    disappears from every real response.
 *
 * The handler is mounted on a bare Hono rather than reached through
 * `getTestApp()`: `getTestApp()` deliberately skips static serving, and the SPA
 * shell it reads (`apps/web/dist/index.html`) is a build artefact that does not
 * exist in a test run — hence the injected reader.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { _resetCacheForTesting } from "@appstrate/env";
import { createSpaFallbackHandler } from "../../../src/routes/spa.ts";

const INDEX_HTML = `<!doctype html><html><head><title>Appstrate</title></head><body><div id="root"></div></body></html>`;
const APP_CONFIG_SCRIPT = `<script>window.__APP_CONFIG__={"features":{}};</script>`;

/**
 * Run `fn` with `USERCONTENT_URL` set to `value` (or unset when undefined),
 * resetting the env cache on both edges — the same mechanism
 * `documents-preview.test.ts` uses for its `USERCONTENT_URL` describe block.
 */
async function withUsercontentUrl(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env.USERCONTENT_URL;
  if (value === undefined) delete process.env.USERCONTENT_URL;
  else process.env.USERCONTENT_URL = value;
  _resetCacheForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.USERCONTENT_URL;
    else process.env.USERCONTENT_URL = prev;
    _resetCacheForTesting();
  }
}

/** Serve the SPA shell exactly as `index.ts` mounts it, and fetch it. */
async function fetchSpa(path = "/"): Promise<Response> {
  const app = new Hono();
  app.get(
    "/*",
    createSpaFallbackHandler(
      () => APP_CONFIG_SCRIPT,
      () => Promise.resolve(INDEX_HTML),
    ),
  );
  return app.request(path);
}

describe("SPA document CSP", () => {
  it("carries a Content-Security-Policy with frame-src", async () => {
    await withUsercontentUrl(undefined, async () => {
      const res = await fetchSpa();
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-src");
    });
  });

  it("sends the header on every SPA route, not just /", async () => {
    await withUsercontentUrl(undefined, async () => {
      const res = await fetchSpa("/agents/some-agent/runs");
      expect(res.headers.get("Content-Security-Policy")).toBe("frame-src 'self'");
    });
  });

  it("names 'self' when USERCONTENT_URL is unset — previews are minted on APP_URL", async () => {
    await withUsercontentUrl(undefined, async () => {
      const res = await fetchSpa();
      expect(res.headers.get("Content-Security-Policy")).toBe("frame-src 'self'");
    });
  });

  it("names the USERCONTENT_URL origin when a separate preview domain is configured", async () => {
    await withUsercontentUrl("https://usercontent.example", async () => {
      const res = await fetchSpa();
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "frame-src https://usercontent.example",
      );
    });
  });

  it("reduces USERCONTENT_URL to its ORIGIN — a path or trailing slash is not a source expression", async () => {
    await withUsercontentUrl("https://usercontent.example:8443/preview/", async () => {
      const res = await fetchSpa();
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "frame-src https://usercontent.example:8443",
      );
    });
  });

  // The load-bearing assertion. `script-src` here would break the Vite build's
  // inline bootstrapping, and `default-src` would break every asset fetch —
  // hardening the whole SPA document is a separate project, not a side effect
  // of the preview containment.
  it("carries frame-src and NO other directive", async () => {
    for (const usercontent of [undefined, "https://usercontent.example"]) {
      await withUsercontentUrl(usercontent, async () => {
        const csp = (await fetchSpa()).headers.get("Content-Security-Policy") ?? "";
        const directives = csp
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => d.split(/\s+/)[0]);
        expect(directives).toEqual(["frame-src"]);
      });
    }
  });

  it("still injects window.__APP_CONFIG__ into the shell", async () => {
    await withUsercontentUrl(undefined, async () => {
      const body = await (await fetchSpa()).text();
      expect(body).toContain("window.__APP_CONFIG__");
      expect(body).toContain('<div id="root"></div>');
      // Injected inside <head>, before the closing tag — not appended after it.
      expect(body.indexOf("__APP_CONFIG__")).toBeLessThan(body.indexOf("</head>"));
    });
  });
});

/**
 * The production WIRING, pinned by reading `index.ts`'s source rather than by
 * making a request — the same technique
 * `apps/web/src/components/test/document-preview.test.ts` uses on its component.
 *
 * A request assertion is not available here: importing `index.ts` boots a real
 * server (it default-exports a `Bun.serve` config and runs the boot sequence),
 * and the SPA shell it reads (`apps/web/dist/index.html`) does not exist under
 * `bun test`, so the handler would throw before any header could be inspected.
 * Without this block the whole suite stays green after a revert to the old
 * inline `app.get("/*", async (c) => …)`: every test above mounts the handler
 * itself, so nothing else notices that no production response carries the CSP.
 */
const INDEX_TS = readFileSync(
  fileURLToPath(new URL("../../../src/index.ts", import.meta.url)),
  "utf-8",
);

describe("SPA fallback wiring in index.ts", () => {
  it("mounts the SPA fallback via createSpaFallbackHandler", () => {
    expect(INDEX_TS).toContain(`import { createSpaFallbackHandler } from "./routes/spa.ts"`);
    expect(INDEX_TS).toContain(`app.get("/*", createSpaFallbackHandler(buildAppConfigScript))`);
  });

  it("does not serve the SPA shell from an inline handler (the CSP would vanish)", () => {
    // The reverted shape: `app.get("/*", async (c) => { … index.html … })`.
    // Any catch-all registered with an inline function body is the regression.
    expect(INDEX_TS).not.toMatch(/app\.get\(\s*"\/\*"\s*,\s*(async\s*)?\(/);
    expect(INDEX_TS).not.toContain("apps/web/dist/index.html");
  });
});
