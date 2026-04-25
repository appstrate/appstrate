// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP exposure of the sidecar's capabilities (Phase 1 of #276).
 *
 * The sidecar already exposes its capabilities as bespoke HTTP routes
 * (`/proxy`, `/run-history`, `/llm/*`). Phase 1 adds an additional `/mcp`
 * endpoint that surfaces those same capabilities through the standard
 * Model Context Protocol so an MCP-aware client (the agent in Phase 5,
 * external `mcp-inspector` for debugging today) can discover and invoke
 * them via `tools/list` + `tools/call`.
 *
 * Key invariants preserved by this module:
 *
 * 1. Existing routes (`/proxy`, `/run-history`, `/llm/*`) are untouched —
 *    Phase 1 is explicitly additive. The MCP tools delegate to the same
 *    Hono routes via in-process `app.request()`. Zero credential code
 *    duplication, zero refactor risk.
 *
 * 2. Stateless transport. We do not maintain an MCP session per client —
 *    each POST is independent. The sidecar runs inside a single agent
 *    container; there is no multi-client multiplexing to worry about.
 *
 * 3. Binary responses (e.g. provider calls returning a PDF) flow through
 *    `/proxy` unchanged. Phase 3 of #276 will surface them as MCP
 *    `resources` — for now the MCP `provider_call` tool restricts itself
 *    to text/JSON responses and emits an explicit error otherwise. This
 *    keeps the wire payload manageable and the contract sharp.
 *
 * The endpoint is mounted at `/mcp` because the spec recommends a single
 * URL for both client → server (POST) and server → client (GET stream).
 * We currently only handle POST + DELETE — GET (SSE replay) is out of
 * scope until Phase 3 introduces server-initiated notifications.
 */

import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type AppstrateToolDefinition } from "@appstrate/mcp-transport";

/**
 * Build the `provider_call` and `run_history` MCP tool definitions backed
 * by the supplied Hono app. Tool handlers re-enter the app via
 * `app.request()` — same code path as an external HTTP caller, but
 * in-process (no socket, no JSON re-serialisation beyond what the route
 * itself does).
 */
function buildSidecarTools(app: Hono): AppstrateToolDefinition[] {
  const providerCall: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description:
        "Make an authenticated request through the sidecar's credential-injecting proxy. " +
        "The sidecar resolves the named provider's credentials and forwards the request to " +
        "the supplied target URL. Use only with provider IDs declared in the agent bundle's " +
        "`dependencies.providers[]`. Binary responses are not yet supported on this path — " +
        "use the legacy `/proxy` endpoint with `X-Stream-Response: 1` for those (Phase 3 will " +
        "add MCP `resources` for binary passthrough).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target"],
        properties: {
          providerId: {
            type: "string",
            description:
              "Provider identifier as declared in `dependencies.providers[].id` (e.g. `appstrate.gmail`).",
            // Mirror the regex enforced by the /proxy route on X-Provider —
            // catching a malformed provider id at the MCP layer means the
            // failure surface is the agent loop, not a 400 deep in /proxy.
            pattern: "^[A-Za-z0-9._@/-]{1,128}$",
          },
          target: {
            type: "string",
            format: "uri",
            description:
              "Absolute target URL. Must match an entry in the provider's `authorizedUris` " +
              "(or be a non-private URL if the provider is `allowAllUris`).",
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
            description: "HTTP method. Defaults to GET.",
          },
          headers: {
            type: "object",
            description:
              "Additional headers to forward. Hop-by-hop headers and the routing " +
              "headers (X-Provider, X-Target, …) are filtered server-side.",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "string",
            description:
              "Request body. Use a JSON-encoded string for JSON endpoints. Binary uploads " +
              "are not supported on this path — use the legacy `/proxy` route.",
          },
          substituteBody: {
            type: "boolean",
            description:
              "When true, the sidecar substitutes `{{credential}}` placeholders in the " +
              "request body. Off by default to avoid accidental token leaks into payloads.",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as {
        providerId: string;
        target: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        substituteBody?: boolean;
      };

      const headers: Record<string, string> = {
        ...(args.headers ?? {}),
        "X-Provider": args.providerId,
        "X-Target": args.target,
      };
      if (args.substituteBody) headers["X-Substitute-Body"] = "1";

      const init: RequestInit = {
        method: args.method ?? "GET",
        headers,
      };
      if (
        args.body !== undefined &&
        args.method &&
        args.method !== "GET" &&
        args.method !== "HEAD"
      ) {
        init.body = args.body;
      }

      const res = await app.request("/proxy", init);
      return responseToToolResult(res);
    },
  };

  const runHistory: AppstrateToolDefinition = {
    descriptor: {
      name: "run_history",
      description:
        "Fetch metadata and optionally the carry-over state or final output of the agent's " +
        "most recent past runs (current run excluded). Returns JSON. " +
        "Use for trend analysis, auditing prior executions, or recovering from a failed run.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Number of past runs to return (1..50, default 10).",
          },
          fields: {
            type: "array",
            items: { type: "string", enum: ["state", "result"] },
            uniqueItems: true,
            description: "Optional subset of `{state, result}` to include per run.",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { limit?: number; fields?: string[] };
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.fields?.length) params.set("fields", args.fields.join(","));
      const qs = params.size > 0 ? `?${params.toString()}` : "";

      const res = await app.request(`/run-history${qs}`);
      return responseToToolResult(res);
    },
  };

  return [providerCall, runHistory];
}

/**
 * Convert a Hono in-process Response into an MCP CallToolResult.
 *
 * Non-OK responses become tool-level errors (`isError: true`) — the
 * model still receives them as data and can react. The SDK reserves
 * thrown errors for protocol-level faults; per-tool 4xx/5xx are
 * domain-level signals.
 */
async function responseToToolResult(res: Response): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const ct = res.headers.get("content-type") ?? "";
  // We deliberately reject non-text responses on this path to keep the
  // surface narrow until Phase 3 introduces MCP resources. Surfacing a
  // PDF byte stream as a base64 text block would mislead the agent into
  // thinking it received a usable text body.
  if (!ct.startsWith("text/") && !ct.includes("json") && !ct.includes("xml")) {
    return {
      content: [
        {
          type: "text",
          text: `provider_call: non-text response of type '${ct || "unknown"}' is not supported on this path; use the legacy /proxy route with X-Stream-Response for binary payloads (Phase 3 will introduce MCP resources).`,
        },
      ],
      isError: true,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Mount the MCP endpoint on the supplied Hono app.
 *
 * Stateless: every POST is a fresh JSON-RPC exchange. Sessions only
 * matter when the server initiates pushes (notifications, sampling
 * requests) — out of scope until Phase 3.
 *
 * Returns a teardown function for tests; production sidecars never tear
 * the endpoint down (the process exits with the agent run).
 */
export function mountMcp(app: Hono): () => Promise<void> {
  const server = createMcpServer(buildSidecarTools(app), {
    name: "appstrate-sidecar",
    version: "1",
  });

  // Stateless mode: passing `sessionIdGenerator: undefined` explicitly
  // disables session tracking. The transport handles each request
  // independently — no state to leak between agent invocations, no map
  // to bound.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // `connect()` is async only because some transports start an upstream
  // process; in-memory + web-standard return immediately. We `void` the
  // promise so the import-time mount is non-blocking, then attach the
  // route — handleRequest() awaits internally on first POST so a slow
  // connect() would only delay the first request, not crash the boot.
  const ready = server.connect(transport);

  app.all("/mcp", async (c) => {
    await ready;
    return transport.handleRequest(c.req.raw);
  });

  return async () => {
    await ready;
    await transport.close();
    await server.close();
  };
}
