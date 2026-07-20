// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { capturePortableBrowserState } from "../src/browser-state.ts";
import { findChromeExecutable, launchLocalChrome, type LocalChrome } from "../src/chrome.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
let chrome: LocalChrome | undefined;
let origin = "";
let unavailableReason: string | null = null;

describe("real Chrome portable-state smoke", () => {
  beforeAll(async () => {
    try {
      await findChromeExecutable();
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
      return;
    }
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          "<!doctype html><script>document.cookie='appstrate_smoke=cookie-value; Path=/; SameSite=Lax';localStorage.setItem('appstrate-smoke','present')</script>",
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Set-Cookie": "appstrate_smoke=cookie-value; Path=/; HttpOnly; SameSite=Lax",
            },
          },
        );
      },
    });
    origin = server.url.origin;
    chrome = await launchLocalChrome([server.url.href], { headless: true });
  });

  afterAll(async () => {
    await chrome?.close();
    server?.stop(true);
  });

  it("extracts cookies and localStorage through the real CDP protocol", async () => {
    if (!chrome) {
      console.warn(`Chrome smoke skipped: ${unavailableReason ?? "unavailable"}`);
      return;
    }
    let state: {
      version: number;
      cookies: Array<{ name: string; value: string; domain: string }>;
      origins: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
      }>;
    };
    const deadline = Date.now() + 5_000;
    for (;;) {
      const encoded = await capturePortableBrowserState(chrome.debuggingOrigin, [origin]);
      state = JSON.parse(encoded) as typeof state;
      if (
        state.origins.some((entry) =>
          entry.localStorage.some(
            (item) => item.name === "appstrate-smoke" && item.value === "present",
          ),
        ) ||
        Date.now() >= deadline
      ) {
        break;
      }
      await Bun.sleep(100);
    }
    expect(state.version).toBe(1);
    expect(state.cookies).toContainEqual(
      expect.objectContaining({ name: "appstrate_smoke", value: "cookie-value" }),
    );
    expect(state.origins).toContainEqual({
      origin,
      localStorage: [{ name: "appstrate-smoke", value: "present" }],
    });
  });
});
