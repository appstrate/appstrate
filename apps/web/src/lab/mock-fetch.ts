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
 *
 * CONSOLE CARVE-OUT — the repo bans `console.*` (CLAUDE.md, CONTRIBUTING.md),
 * a rule aimed at the API, where `lib/logger.ts` emits structured JSON to
 * stdout. This file is a browser-side dev harness that a serve-only Vite plugin
 * injects and that never enters a production bundle, and the console IS its
 * output device: a missing fixture has to announce itself where the developer
 * is already looking. Stated here rather than left silent.
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

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function installLabFetch(): void {
  const labFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), window.location.origin);
    const method = requestMethod(input, init);

    // Vite's own dev traffic (/@vite, /src/…, /node_modules/…) and any asset
    // must reach the dev server untouched — only backend calls are faked.
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);

    // The scoping headers travel with the request: a handler that answers an
    // org-scoped list has to answer for the org that was ASKED for, not for
    // whichever one the app happens to be in — that is the whole difference
    // between one org and several in the lab.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // Internal lab context only. The empty scenario normally removes the orgs
    // and lands on onboarding, but a permanent detail URL must keep its shell
    // so the authored detail survivor can be inspected in that scenario.
    headers.set("X-Appstrate-Lab-Location", window.location.pathname);
    const handled = resolveHandler(
      method,
      url,
      getScenario(),
      headers,
      await requestBody(input, init),
    );

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
    // 204 carries no body — `Response.json` throws on one, and the endpoints
    // that answer 204 (the chat's resume probe) are read as "nothing running".
    if (handled.status === 204) return new Response(null, { status: 204 });
    // Bytes, for the routes that serve a file rather than a document about one.
    if (handled.contentType) {
      return new Response(handled.body as BodyInit, {
        status: handled.status,
        headers: { "content-type": handled.contentType },
      });
    }
    return Response.json(handled.body, {
      status: handled.status,
      headers: {
        "content-type": handled.status >= 400 ? "application/problem+json" : "application/json",
      },
    });
  };

  window.fetch = Object.assign(labFetch, { preconnect: nativeFetch.preconnect });
}
