// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a URL falls on an integration's remote MCP endpoint. A leaf module: it imports nothing,
 * so the run sidecar and the platform can load it without the integration manifest machinery.
 */

/**
 * Lower-cased path with each valid `%XX` triplet decoded on its own (a malformed escape elsewhere
 * in the path stays as written), `;params` dropped from every segment, and repeated and trailing
 * slashes collapsed.
 */
function normalisedPath(url: URL): string {
  return url.pathname
    .replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16)))
    .split("/")
    .map((segment) => {
      const params = segment.indexOf(";");
      return params === -1 ? segment : segment.slice(0, params);
    })
    .join("/")
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/** A remote MCP server as its integration declares it: `server.url` and `server.transport`. */
export interface McpEndpoint {
  url: string;
  transport?: string;
}

/**
 * Whether `target` falls on the MCP endpoint: same origin (scheme, host without a trailing dot,
 * port), and
 *   - over SSE, any path: the server announces the endpoint its messages are POSTed to, at a path
 *     of its choosing on that origin (often outside `server.url`'s), so the whole origin is it;
 *   - otherwise, a path equal to the endpoint's or under it (`<path>/…`), compared
 *     case-insensitively after percent-decoding each valid `%XX`, with `;params` dropped from
 *     every segment and repeated and trailing slashes collapsed; query and fragment ignored. An
 *     endpoint at the origin root matches the root path only, so the other paths of that host
 *     stay reachable.
 */
export function targetsMcpEndpoint(target: string | URL, endpoint: McpEndpoint): boolean {
  if (!URL.canParse(String(target)) || !URL.canParse(endpoint.url)) return false;
  const t = new URL(target);
  const e = new URL(endpoint.url);
  const host = (u: URL) => u.hostname.replace(/\.$/, "");
  if (t.protocol !== e.protocol || host(t) !== host(e) || t.port !== e.port) return false;
  if (endpoint.transport === "sse") return true;
  const base = normalisedPath(e);
  const path = normalisedPath(t);
  return path === base || (base !== "" && path.startsWith(`${base}/`));
}
