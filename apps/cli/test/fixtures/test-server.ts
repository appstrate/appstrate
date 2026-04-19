// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal `Bun.serve()`-based fixture for integration-testing
 * `appstrate api`. Intentionally lightweight — no routing framework,
 * just a switch on `pathname`.
 *
 * Two servers are usually started in parallel: one primary, and one
 * "peer" on a different port so the cross-origin redirect-strip test
 * can hop across origins. Both record every incoming request on a
 * shared log so tests can assert server-side observations (headers
 * received, body bytes, etc.) without mocking fetch.
 *
 * Port 0 means the kernel picks — no CI port collisions.
 */

import { createHash } from "node:crypto";

export interface RequestLog {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBytes?: Uint8Array;
  bodyHash?: string;
  formFields?: Record<
    string,
    string | { name?: string; size: number; type: string; sha256: string }
  >;
}

export interface TestServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
  calls: RequestLog[];
  /** Known constant payload served by /binary — tests compare against this. */
  binaryPayload: Uint8Array;
}

export async function startTestServer(
  opts: { redirectTargetUrl?: () => string | undefined } = {},
): Promise<TestServerHandle> {
  const calls: RequestLog[] = [];

  // 1 MB of deterministic pseudo-random bytes for binary byte-exact tests.
  const binaryPayload = new Uint8Array(1024 * 1024);
  for (let i = 0; i < binaryPayload.length; i++) binaryPayload[i] = (i * 2654435761) & 0xff;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headerRecord: Record<string, string> = {};
      for (const [k, v] of req.headers) headerRecord[k] = v;

      // Capture body (for routes that need to inspect it). Clone so the
      // main handler can still .formData() / .text() / .arrayBuffer().
      const log: RequestLog = { method: req.method, path: u.pathname, headers: headerRecord };

      switch (u.pathname) {
        case "/json": {
          calls.push(log);
          return Response.json({ ok: true, path: u.pathname });
        }
        case "/echo": {
          // Mirror back the request body + content-type so the client
          // can verify round-trip fidelity for arbitrary payloads.
          const bytes = new Uint8Array(await req.arrayBuffer());
          log.bodyBytes = bytes;
          log.bodyHash = createHash("sha256").update(bytes).digest("hex");
          calls.push(log);
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": req.headers.get("content-type") ?? "application/octet-stream",
            },
          });
        }
        case "/multipart": {
          // Parse as FormData, record per-field observations.
          const fd = await req.formData();
          const fields: Record<
            string,
            string | { name?: string; size: number; type: string; sha256: string }
          > = {};
          for (const [k, v] of fd.entries()) {
            if (typeof v === "string") {
              fields[k] = v;
            } else {
              const buf = new Uint8Array(await v.arrayBuffer());
              fields[k] = {
                name: "name" in v ? (v as File).name : undefined,
                size: v.size,
                type: v.type,
                sha256: createHash("sha256").update(buf).digest("hex"),
              };
            }
          }
          log.formFields = fields;
          calls.push(log);
          return Response.json({ received: Object.keys(fields) });
        }
        case "/redirect/same": {
          calls.push(log);
          // Point same-origin to /json.
          return Response.redirect(new URL("/json", req.url).toString(), 302);
        }
        case "/redirect/cross": {
          // Cross-origin redirect — target points at the peer server.
          calls.push(log);
          const peer = opts.redirectTargetUrl?.();
          if (!peer) return new Response("no peer configured", { status: 500 });
          return Response.redirect(`${peer}/peek-auth`, 302);
        }
        case "/peek-auth": {
          // Records whether Authorization made it across the hop.
          calls.push(log);
          return Response.json({
            authorization: req.headers.get("authorization"),
            cookie: req.headers.get("cookie"),
          });
        }
        case "/sse": {
          // Direct ReadableStream with explicit flush() after each event
          // so the consumer actually sees per-frame delivery (the point
          // being tested on the client side).
          calls.push(log);
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const enc = new TextEncoder();
              for (let i = 0; i < 3; i++) {
                controller.enqueue(enc.encode(`event: tick\ndata: ${i}\n\n`));
                // Small delay between frames so the client can measure
                // per-chunk arrival separation.
                await new Promise((r) => setTimeout(r, 20));
              }
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        case "/slow": {
          // Never closes until the client aborts (for SIGINT / timeout tests).
          calls.push(log);
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const enc = new TextEncoder();
              const abort = req.signal as unknown as AbortSignal | undefined;
              let closed = false;
              abort?.addEventListener("abort", () => {
                closed = true;
                try {
                  controller.close();
                } catch {
                  /* ignore */
                }
              });
              for (let i = 0; !closed && i < 1000; i++) {
                controller.enqueue(enc.encode(`chunk-${i}\n`));
                await new Promise((r) => setTimeout(r, 50));
              }
              try {
                controller.close();
              } catch {
                /* ignore */
              }
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        case "/binary": {
          calls.push(log);
          return new Response(binaryPayload, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        case "/404":
          calls.push(log);
          return new Response("not found", { status: 404 });
        case "/500":
          calls.push(log);
          return new Response("boom", { status: 500 });
        case "/401":
          calls.push(log);
          return new Response("unauthorized", { status: 401 });
        default:
          calls.push(log);
          return new Response("unknown route", { status: 404 });
      }
    },
  });

  // `Bun.serve({ port: 0 })` always assigns a concrete port by the time
  // it resolves — the typings are pessimistic.
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => {
      server.stop(true);
      return Promise.resolve();
    },
    calls,
    binaryPayload,
  };
}
