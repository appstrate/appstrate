// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Issue #403 — per-URL TLS-client routing.
 *
 * Wraps a default `fetch` (Bun/undici) and a {@link curlFetch} into a single
 * `fetch`-shaped function that picks the client per request URL, driven by the
 * integration's `_meta["dev.appstrate/tls-client"].routes` (resolved into
 * {@link TlsClientRoute}s on the spawn spec). First matching route wins; an
 * unmatched URL — or a route whose `client` is `"undici"` — uses the default
 * `fetch`. This is the ONLY behavioural change: it's injected as the MITM
 * listener's `fetch`, so credential injection, SSRF checks, retries, and
 * response passthrough are all untouched.
 *
 * Routes are matched with the SAME glob semantics as `authorized_uris`
 * ({@link matchesAuthorizedUriSpec}) so authors reuse one pattern language.
 */

import { matchesAuthorizedUriSpec } from "@appstrate/connect/proxy-primitives";
import type { TlsClientRoute } from "@appstrate/core/integration";
import {
  curlFetch,
  resolveCurlRunnerConfig,
  type CurlRunnerConfig,
  type FetchInput,
  type FetchInit,
} from "./curl-runner.ts";

export interface TlsClientRouterOptions {
  /** Default client for unmatched URLs. Defaults to `globalThis.fetch`. */
  defaultFetch?: typeof fetch;
  /** curl runner config — defaults to {@link resolveCurlRunnerConfig}. */
  curlConfig?: CurlRunnerConfig;
  /** Override the curl implementation (tests). Defaults to {@link curlFetch}. */
  curlFetchImpl?: typeof curlFetch;
  /** Telemetry — fired when a request is routed through a non-default client. */
  onRoute?: (info: { url: string; client: TlsClientRoute["client"]; impersonate?: string }) => void;
}

/** Extract the URL string from a `fetch` first argument. */
function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** First route whose pattern matches `url`, or null. */
function matchRoute(routes: readonly TlsClientRoute[], url: string): TlsClientRoute | null {
  for (const route of routes) {
    if (matchesAuthorizedUriSpec(route.urlPattern, url)) return route;
  }
  return null;
}

/**
 * Build a `fetch`-compatible function that routes per URL. When `routes` is
 * empty the default `fetch` is returned unchanged (zero overhead for the common
 * case). The curl runner config is resolved lazily — only when at least one
 * `curl` route exists — so integrations that declare no curl route never touch
 * the environment.
 */
export function makeTlsClientFetch(
  routes: readonly TlsClientRoute[],
  options: TlsClientRouterOptions = {},
): typeof fetch {
  const defaultFetch = options.defaultFetch ?? globalThis.fetch;
  if (routes.length === 0) return defaultFetch;

  const hasCurlRoute = routes.some((r) => r.client === "curl");
  // Resolve curl config once (lazily). A misconfigured environment surfaces
  // here at boot rather than on the first matched request.
  const curlConfig = hasCurlRoute ? (options.curlConfig ?? resolveCurlRunnerConfig()) : null;
  const curlImpl = options.curlFetchImpl ?? curlFetch;

  const routed = async (input: FetchInput, requestInit?: FetchInit): Promise<Response> => {
    const url = urlOf(input);
    const route = matchRoute(routes, url);
    if (!route || route.client !== "curl" || !curlConfig) {
      return defaultFetch(input, requestInit);
    }
    options.onRoute?.({ url, client: route.client, impersonate: route.impersonate });
    const init = requestInit ?? {};
    return curlImpl(
      url,
      {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal ?? null,
        ...(route.impersonate ? { impersonate: route.impersonate } : {}),
      },
      curlConfig,
    );
  };
  // The routed wrapper is a structural `fetch` minus the rarely-used
  // `preconnect` method (the sidecar never calls it). Cast so it satisfies the
  // injected-`fetch` parameter type of the MITM listener.
  return routed as typeof fetch;
}
