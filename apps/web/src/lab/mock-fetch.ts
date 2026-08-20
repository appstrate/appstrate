// SPDX-License-Identifier: Apache-2.0

/**
 * Lab mode: answer every backend call in the browser, from fixtures.
 *
 * WHY `window.fetch` AND NOT THE TYPED CLIENT'S MIDDLEWARE — the first screen
 * needs three different callers, and only one of them goes through
 * `api/client.ts`:
 *   - `authClient.getSession()`  → better-auth's own fetch (`/api/auth/*`)
 *   - `$api` / `client.GET(...)` → openapi-fetch (`/api/*`)
 *   - SSE streams and uploads    → hand-rolled fetch (see lib/scoping-headers)
 * Patching `fetch` covers all three at once, so no caller needs a lab-aware
 * branch and no page or hook is modified to run in the lab.
 *
 * Everything above this seam behaves exactly as in production: React Query
 * caches, `Suspense` fallbacks run, `ApiError` is thrown from non-2xx bodies,
 * mutations invalidate. What changes is only what comes back off the wire.
 */
import { getScenario } from "./scenario";
import { resolveHandler } from "./handlers";

// Read the statics off the unbound value (`typeof fetch` carries `preconnect`),
// but call through a bound copy — a detached `fetch` throws "Illegal invocation".
const nativeFetch = window.fetch;
const originalFetch = nativeFetch.bind(window);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

export function installLabFetch(): void {
  const labFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), window.location.origin);
    const method = requestMethod(input, init);

    // Vite's own dev traffic (/@vite, /src/…, /node_modules/…) and any asset
    // must reach the dev server untouched — only backend calls are faked.
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);

    const handled = resolveHandler(method, url, getScenario());

    if (!handled) {
      // Loud on purpose. An unfaked endpoint is a hole in the fixtures, and a
      // silent 404 here shows up much later as an empty screen you mistake
      // for a design decision.
      console.warn(`[lab] no fixture for ${method} ${url.pathname}${url.search} → 404`);
      return Response.json(
        {
          type: "about:blank",
          title: "Lab: no fixture",
          status: 404,
          detail: `${method} ${url.pathname}`,
        },
        { status: 404, headers: { "content-type": "application/problem+json" } },
      );
    }

    // Server-sent events: hand back an open stream that never emits. Closing it
    // or answering 404 puts the client into a reconnect loop that floods the
    // console and makes the lab unusable.
    if (handled.stream) {
      return new Response(new ReadableStream({ start: () => {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    // A small delay keeps loading states visible. Without it every skeleton
    // flashes for one frame and you never get to look at it.
    await new Promise((r) => setTimeout(r, handled.delayMs ?? 120));

    console.debug(`[lab] ${method} ${url.pathname} → ${handled.status}`);
    return Response.json(handled.body, {
      status: handled.status,
      headers: {
        "content-type": handled.status >= 400 ? "application/problem+json" : "application/json",
      },
    });
  };

  window.fetch = Object.assign(labFetch, { preconnect: nativeFetch.preconnect });
}
