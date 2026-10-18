// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { fetchSiteIcon, iconOrigins, rasterIcon } from "../../../src/services/integration-icon.ts";

/** A PNG header the byte sniffer reads as `image/png`. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
/** An ICO directory header. */
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const html = (head: string) =>
  new Response(`<html><head>${head}</head><body></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
const image = (bytes: Uint8Array, type = "image/png") =>
  new Response(bytes, { headers: { "Content-Type": type } });

function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new Request(String(input)).url;
    seen.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("iconOrigins", () => {
  it("adds the registrable domain of a host below it", () => {
    expect(iconOrigins("https://mcp.notion.com/mcp")).toEqual([
      "https://mcp.notion.com",
      "https://notion.com",
    ]);
    expect(iconOrigins("https://notion.com/mcp")).toEqual(["https://notion.com"]);
    // The Public Suffix List, not the label count: `co.uk` is a suffix.
    expect(iconOrigins("https://mcp.example.co.uk/mcp")).toEqual([
      "https://mcp.example.co.uk",
      "https://example.co.uk",
    ]);
    expect(iconOrigins("https://example.co.uk/mcp")).toEqual(["https://example.co.uk"]);
    expect(iconOrigins("http://127.0.0.1:4000/mcp")).toEqual(["http://127.0.0.1:4000"]);
  });
});

describe("fetchSiteIcon", () => {
  it("prefers the apple-touch-icon, skips an SVG, and returns a data URI", async () => {
    const { fetchImpl } = fakeFetch({
      "https://app.test/": () =>
        html('<link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/touch.png">'),
      "https://app.test/icon.svg": () => image(SVG, "image/svg+xml"),
      "https://app.test/touch.png": () => image(PNG),
    });
    const icon = await fetchSiteIcon("https://app.test/mcp", fetchImpl);
    expect(icon).toBe(`data:image/png;base64,${PNG.toBase64()}`);
  });

  it("never takes an SVG, whatever its declared type", async () => {
    const { fetchImpl } = fakeFetch({
      "https://svg.test/": () => html('<link rel="shortcut icon" href="/favicon.png">'),
      "https://svg.test/favicon.png": () => image(SVG, "image/png"),
      "https://svg.test/favicon.ico": () => image(SVG, "image/x-icon"),
    });
    expect(await fetchSiteIcon("https://svg.test/mcp", fetchImpl)).toBeNull();
  });

  it("falls back to /favicon.ico, then to the parent domain", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "https://example.test/favicon.ico": () => image(ICO, "image/vnd.microsoft.icon"),
    });
    const icon = await fetchSiteIcon("https://mcp.example.test/mcp", fetchImpl);
    expect(icon).toStartWith("data:image/x-icon;base64,");
    expect(seen).toEqual([
      "https://mcp.example.test/",
      "https://mcp.example.test/favicon.ico",
      "https://example.test/",
      "https://example.test/favicon.ico",
    ]);
  });

  it("refuses an icon larger than 256 KiB", async () => {
    const big = new Uint8Array(256 * 1024 + 1);
    big.set(PNG);
    const { fetchImpl } = fakeFetch({ "https://big.test/favicon.ico": () => image(big) });
    expect(await fetchSiteIcon("https://big.test/mcp", fetchImpl)).toBeNull();
  });
});

describe("rasterIcon", () => {
  const png = `data:image/png;base64,${PNG.toBase64()}`;
  const noFetch = (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch;

  it("sniffs a data URI's bytes, never its declared type", async () => {
    expect(await rasterIcon(png, noFetch)).toBe(png);
    expect(await rasterIcon(`data:image/x-icon;base64,${ICO.toBase64()}`, noFetch)).toBe(
      `data:image/x-icon;base64,${ICO.toBase64()}`,
    );
    expect(await rasterIcon(`data:image/png;base64,${SVG.toBase64()}`, noFetch)).toBeNull();
    expect(await rasterIcon("data:image/png,not-base64", noFetch)).toBeNull();
  });

  it("fetches an http(s) URL and refuses any other scheme", async () => {
    const { fetchImpl, seen } = fakeFetch({ "https://cdn.test/logo.png": () => image(PNG) });
    expect(await rasterIcon("https://cdn.test/logo.png", fetchImpl)).toBe(png);
    expect(await rasterIcon("file:///etc/passwd", fetchImpl)).toBeNull();
    expect(seen).toEqual(["https://cdn.test/logo.png"]);
  });
});
