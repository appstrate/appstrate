// SPDX-License-Identifier: Apache-2.0

export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    throw new Error("BROWSER_ALLOWED_ORIGINS_JSON is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 64 ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error("BROWSER_ALLOWED_ORIGINS_JSON is invalid");
  }
  try {
    return parsed.map((value) => {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.origin !== value ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("not a canonical HTTPS origin");
      }
      return value;
    });
  } catch {
    throw new Error("BROWSER_ALLOWED_ORIGINS_JSON is invalid");
  }
}

export interface BrowserCommandPolicyInput {
  readonly method: string;
  readonly browserContextId?: string;
  readonly activeContext: string | null;
  readonly pageTargets: number;
  readonly pendingPageCreations: number;
  readonly maxPages: number;
}

/** One worker is already the isolation boundary, so its default profile is owned. */
export const DEFAULT_BROWSER_CONTEXT = "__appstrate_default_browser_context__";

function usesOwnedContext(
  requestedContext: string | undefined,
  activeContext: string | null,
): boolean {
  return activeContext === DEFAULT_BROWSER_CONTEXT
    ? requestedContext === undefined
    : !!activeContext && requestedContext === activeContext;
}

const CDP_TUNNEL_METHODS = new Set([
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Target.sendMessageToTarget",
]);

/**
 * Restored cookies must name a host explicitly authorized by the manifest.
 * Accepting arbitrary parent domains would make `.com` match `example.com`;
 * callers that need a registrable-domain cookie must declare that exact host
 * as an origin alongside any subdomain they navigate to.
 */
export function isCookieDomainAllowed(
  rawDomain: string,
  allowedOrigins: readonly string[],
): boolean {
  const domain = rawDomain.replace(/^\./, "").toLowerCase();
  if (!domain) return false;
  return allowedOrigins.some((origin) => new URL(origin).hostname.toLowerCase() === domain);
}

const READ_ONLY_DEVTOOLS_PATHS = new Set([
  "/json",
  "/json/",
  "/json/list",
  "/json/list/",
  "/json/protocol",
  "/json/protocol/",
  "/json/version",
  "/json/version/",
]);

/**
 * Chrome also exposes mutating HTTP helpers such as `/json/new` and
 * `/json/close/<target>`. Relaying those would bypass the CDP command broker,
 * its owned-context check, and the page ceiling. Only discovery documents are
 * needed to establish a CDP connection.
 */
export function isReadOnlyDevtoolsDiscoveryRequest(
  method: string,
  pathname: string,
  search: string,
): boolean {
  return method === "GET" && search === "" && READ_ONLY_DEVTOOLS_PATHS.has(pathname);
}

/** CDP commands are request/response messages and require a bounded numeric id. */
export function hasValidCdpCommandEnvelope(method: unknown, id: unknown): boolean {
  return (
    typeof method === "string" &&
    method.length > 0 &&
    Number.isSafeInteger(id) &&
    typeof id === "number" &&
    id >= 0
  );
}

/** Return an agent-safe denial message, or null when the CDP call may pass. */
export function browserCommandDenial(input: BrowserCommandPolicyInput): string | null {
  if (CDP_TUNNEL_METHODS.has(input.method)) {
    return "nested DevTools protocol channels are forbidden";
  }
  if (
    input.method === "Target.createBrowserContext" ||
    input.method === "Target.disposeBrowserContext" ||
    input.method === "Browser.close"
  ) {
    return "browser contexts are owned by the Appstrate worker";
  }
  if (input.method === "Target.createTarget") {
    if (!usesOwnedContext(input.browserContextId, input.activeContext)) {
      return "pages must use the Appstrate-owned browser context";
    }
    if (input.pageTargets + input.pendingPageCreations >= input.maxPages) {
      return "browser page limit reached";
    }
  }
  if (
    input.method === "Storage.getCookies" ||
    input.method === "Storage.setCookies" ||
    input.method === "Storage.clearCookies"
  ) {
    if (!usesOwnedContext(input.browserContextId, input.activeContext)) {
      return "cookie access must use the Appstrate-owned browser context";
    }
  }
  return null;
}
