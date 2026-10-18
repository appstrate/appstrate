// SPDX-License-Identifier: Apache-2.0

/**
 * A site's raster icon, read once when an integration is discovered and handed
 * back as a data URI: the platform never stores a third-party icon URL.
 */

import { fileTypeFromBuffer } from "file-type";
import { parse } from "tldts";
import { readBodyPrefix, readBodyUnder } from "../lib/capped-body.ts";

const ICON_MAX_BYTES = 256 * 1024;
/** The `<head>` is near the top; a homepage can weigh megabytes. */
const HTML_HEAD_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_LINKED_ICONS = 4;
/** Sniffed from the bytes, never the declared type. SVG is a document (scripts), never taken. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
]);

/** The origin, then its registrable domain's (`mcp.example.co.uk` → `example.co.uk`). */
export function iconOrigins(url: string): string[] {
  const u = new URL(url);
  const { domain } = parse(u.hostname, { allowPrivateDomains: true, extractHostname: false });
  return domain && domain !== u.hostname ? [u.origin, `${u.protocol}//${domain}`] : [u.origin];
}

/** The first raster icon of the URL's site (linked icons, then `/favicon.ico`) as a data URI, or null. */
export async function fetchSiteIcon(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  for (const origin of iconOrigins(url)) {
    const candidates = [...(await linkedIcons(`${origin}/`, fetchImpl)), `${origin}/favicon.ico`];
    for (const candidate of candidates) {
      const icon = await fetchRaster(candidate, fetchImpl);
      if (icon) return icon;
    }
  }
  return null;
}

/** `<link rel="icon|shortcut icon|apple-touch-icon">` hrefs of a page, apple-touch-icon first. */
async function linkedIcons(pageUrl: string, fetchImpl: typeof fetch): Promise<string[]> {
  let html: string;
  try {
    const res = await fetchImpl(pageUrl, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) {
      await res.body?.cancel();
      return [];
    }
    html = await readBodyPrefix(res, HTML_HEAD_MAX_BYTES, (text) => /<\/head>/i.test(text));
  } catch {
    return [];
  }
  const found: { href: string; touch: boolean }[] = [];
  await new HTMLRewriter()
    .on("link[rel][href]", {
      element(el) {
        const rel = el.getAttribute("rel")!.toLowerCase().split(/\s+/);
        const touch = rel.includes("apple-touch-icon");
        if (!touch && !rel.includes("icon")) return;
        // Against the page URL, not `res.url`: the guarded fetch reports the pinned address there.
        const href = URL.parse(el.getAttribute("href")!, pageUrl);
        if (href?.protocol === "https:" || href?.protocol === "http:") {
          found.push({ href: href.href, touch });
        }
      },
    })
    .transform(new Response(html))
    .text();
  // An apple-touch-icon is a raster by convention, sized for a tile.
  return [...found.filter((f) => f.touch), ...found.filter((f) => !f.touch)]
    .slice(0, MAX_LINKED_ICONS)
    .map((f) => f.href);
}

/** An MCP `Implementation.icons[].src` (`http(s)` or `data:`) as a raster data URI, or null. */
export async function rasterIcon(src: string, fetchImpl: typeof fetch): Promise<string | null> {
  const url = URL.parse(src);
  if (url?.protocol === "http:" || url?.protocol === "https:")
    return fetchRaster(url.href, fetchImpl);
  const data = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!data) return null;
  try {
    return await rasterDataUri(Uint8Array.fromBase64(data[1]!.replace(/\s/g, "")));
  } catch {
    return null;
  }
}

async function fetchRaster(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await readBodyUnder(res, ICON_MAX_BYTES);
    return bytes ? await rasterDataUri(bytes) : null;
  } catch {
    return null;
  }
}

async function rasterDataUri(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES) return null;
  const type = (await fileTypeFromBuffer(bytes))?.mime;
  return type && RASTER_TYPES.has(type) ? `data:${type};base64,${bytes.toBase64()}` : null;
}
