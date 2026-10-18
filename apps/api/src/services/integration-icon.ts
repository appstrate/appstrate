// SPDX-License-Identifier: Apache-2.0

/**
 * A site's raster icon, read once when an integration is discovered and handed
 * back as a data URI: the platform never stores a third-party icon URL.
 *
 * Every `fetchImpl` here must return redirects unfollowed: each hop is judged here
 * (MCP icon rules: https, no change of scheme, a server icon on the server's origin).
 */

import { fileTypeFromBuffer } from "file-type";
import { parse } from "tldts";
import { readBodyPrefix, readBodyUnder } from "../lib/capped-body.ts";
import { egressFetchImpl } from "../lib/egress-host-guard.ts";

const ICON_MAX_BYTES = 256 * 1024;
/** The `<head>` is near the top; a homepage can weigh megabytes. */
const HTML_HEAD_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_LINKED_ICONS = 4;
const MAX_REDIRECTS = 5;
/** Sniffed from the bytes, never the declared type. SVG is a document (scripts), never taken. */
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
]);

/** The egress-guarded fetch every icon lookup must use: it hands redirects back unfollowed. */
export const siteIconFetch = () => egressFetchImpl({ followRedirects: false });

/** The origin, then its registrable domain's (`mcp.example.co.uk` → `example.co.uk`). */
export function iconOrigins(url: string): string[] {
  const u = new URL(url);
  const { domain } = parse(u.hostname, { allowPrivateDomains: true, extractHostname: false });
  return domain && domain !== u.hostname ? [u.origin, `${u.protocol}//${domain}`] : [u.origin];
}

/** The first raster icon of the URL's site (linked icons, then `/favicon.ico`) as a data URI, or null. */
export async function fetchSiteIcon(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  if (new URL(url).protocol !== "https:") return null;
  for (const origin of iconOrigins(url)) {
    const candidates = [...(await linkedIcons(`${origin}/`, fetchImpl)), `${origin}/favicon.ico`];
    for (const candidate of candidates) {
      const icon = await fetchRaster(candidate, fetchImpl, isPlainHttps);
      if (icon) return icon;
    }
  }
  return null;
}

/** `<link rel="icon|shortcut icon|apple-touch-icon">` hrefs of a page, apple-touch-icon first. */
async function linkedIcons(pageUrl: string, fetchImpl: typeof fetch): Promise<string[]> {
  let html: string;
  let baseUrl: string;
  try {
    const page = await fetchHops(pageUrl, "text/html", fetchImpl, isPlainHttps);
    if (!page) return [];
    const { res } = page;
    if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) {
      await res.body?.cancel();
      return [];
    }
    baseUrl = page.url;
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
        // Against the logical URL, not `res.url`: the guarded fetch reports the pinned address there.
        const href = URL.parse(el.getAttribute("href")!, baseUrl);
        if (href && isPlainHttps(href)) {
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

/**
 * An MCP `Implementation.icons[].src` as a raster data URI, or null. Per the MCP icon rules, a
 * `data:` URI or an https URL of the MCP server's own origin, every redirect staying on it.
 */
export async function rasterIcon(
  src: string,
  serverUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const url = URL.parse(src);
  if (url?.protocol === "https:") {
    const { origin } = new URL(serverUrl);
    const sameOrigin = (hop: URL) => isHttps(hop) && !hasUserinfo(hop) && hop.origin === origin;
    return sameOrigin(url) ? fetchRaster(url.href, fetchImpl, sameOrigin) : null;
  }
  const data = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (!data) return null;
  try {
    return await rasterDataUri(Uint8Array.fromBase64(data[1]!.replace(/\s/g, "")));
  } catch {
    return null;
  }
}

const isHttps = (url: URL) => url.protocol === "https:";
/** `https://user:pw@host/` credentials never ride an icon fetch. */
const hasUserinfo = (url: URL) => url.username !== "" || url.password !== "";
const isPlainHttps = (url: URL) => isHttps(url) && !hasUserinfo(url);

/** GET `url`, following up to {@link MAX_REDIRECTS} redirects `allow` accepts; null on any other. */
async function fetchHops(
  url: string,
  accept: string,
  fetchImpl: typeof fetch,
  allow: (hop: URL) => boolean,
): Promise<{ res: Response; url: string } | null> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // No credential: a plain GET, cookies and Authorization never set.
    const res = await fetchImpl(current.href, {
      headers: { Accept: accept },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location === null) return { res, url: current.href };
    await res.body?.cancel();
    const next = URL.parse(location, current.href);
    if (!next || !allow(next)) return null;
    current = next;
  }
  return null;
}

async function fetchRaster(
  url: string,
  fetchImpl: typeof fetch,
  allow: (hop: URL) => boolean,
): Promise<string | null> {
  try {
    const fetched = await fetchHops(url, "image/*", fetchImpl, allow);
    if (!fetched) return null;
    const { res } = fetched;
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
