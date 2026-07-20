// SPDX-License-Identifier: Apache-2.0

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createNetServer } from "node:net";

import {
  browserCommandDenial,
  DEFAULT_BROWSER_CONTEXT,
  hasValidCdpCommandEnvelope,
  isReadOnlyDevtoolsDiscoveryRequest,
} from "@appstrate/core/browser-cdp-policy";
import type { BrowserHandle, BrowserProvider, SpawnBrowserOptions } from "./browser-provider.ts";
import { registerBrowserProvider } from "./browser-provider.ts";

const CLOUD_API = "https://api.browser-use.com/api/v2/browsers";
const MAX_CDP_MESSAGE_BYTES = 1024 * 1024;
const MAX_PENDING_CDP_MESSAGES = 1024;
const MAX_INFLIGHT_CDP_COMMANDS = 2048;

interface CloudSession {
  id: string;
  cdpUrl: string;
  liveUrl: string | null;
}

interface CloudCustomProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
  ignoreCertErrors: false;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCloudProfileId(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.BROWSER_USE_CLOUD_PROFILE_ID;
  if (value === undefined || value === "") return undefined;
  if (!UUID_PATTERN.test(value)) {
    throw new Error("BROWSER_USE_CLOUD_PROFILE_ID must be a UUID");
  }
  return value;
}

function parseCloudCustomProxy(env: NodeJS.ProcessEnv): CloudCustomProxy | undefined {
  const keys = [
    "BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST",
    "BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT",
    "BROWSER_USE_CLOUD_CUSTOM_PROXY_USERNAME",
    "BROWSER_USE_CLOUD_CUSTOM_PROXY_PASSWORD",
  ] as const;
  const configured = keys.some((key) => env[key] !== undefined && env[key] !== "");
  if (!configured) return undefined;

  const host = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST?.trim();
  const portRaw = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT?.trim();
  if (!host || host.length > 253 || /[\u0000-\u0020\u007f/?#@]/u.test(host) || !portRaw) {
    throw new Error("Browser Use Cloud custom proxy requires a valid host and port");
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT must be an integer from 1 to 65535");
  }

  const username = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_USERNAME;
  const password = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_PASSWORD;
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("Browser Use Cloud custom proxy username and password must be set together");
  }
  if (
    username !== undefined &&
    (username.length === 0 ||
      username.length > 512 ||
      password!.length === 0 ||
      password!.length > 4096)
  ) {
    throw new Error("Browser Use Cloud custom proxy credentials are invalid");
  }

  return {
    host,
    port,
    ...(username !== undefined ? { username, password } : {}),
    // The remote proxy is an operator trust boundary. Never make certificate
    // errors invisible to the cloud browser merely to accommodate a proxy.
    ignoreCertErrors: false,
  };
}

function isBrowserUseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "browser-use.com" || host.endsWith(".browser-use.com");
}

function parseCloudInteractionUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned a malformed live URL");
  }
  let live: URL;
  try {
    live = new URL(value);
  } catch {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned a malformed live URL");
  }
  if (
    live.protocol !== "https:" ||
    live.username ||
    live.password ||
    !isBrowserUseHost(live.hostname)
  ) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned an unsafe live URL");
  }
  return live.toString();
}

interface BrokerData {
  upstream?: WebSocket;
  pending: Array<string | Buffer>;
  commands: Map<number, { method: string; targetId?: string }>;
}

export function isAllowedCloudNavigation(
  rawUrl: unknown,
  allowedOrigins: readonly string[],
): boolean {
  if (rawUrl === "about:blank") return true;
  if (typeof rawUrl !== "string") return false;
  try {
    return allowedOrigins.includes(new URL(rawUrl).origin);
  } catch {
    return false;
  }
}

interface CloudBroker {
  readonly endpoint: string;
  close(): Promise<void>;
}

function bearerMatches(request: Request, token: string): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Local authenticated CDP broker. The paid cloud CDP URL (which contains
 * session authority) stays sidecar-private; integration runners receive only
 * this per-run bearer endpoint. The same lifecycle/tunnel policy as the local
 * worker is applied before commands reach Browser Use Cloud.
 */
async function reservePort(host: string): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, host, resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("BROWSER_UNAVAILABLE: cloud CDP broker could not reserve a port");
  return port;
}

export async function createBrowserUseCloudBroker(input: {
  upstreamUrl: string;
  authToken: string;
  maxPages: number;
  allowedOrigins: readonly string[];
  bindHost: string;
  advertisedHost: string;
}): Promise<CloudBroker> {
  let pageTargets = 0;
  let pendingPageCreations = 0;
  const sockets = new Set<{ close(code?: number, reason?: string): void }>();
  const port = await reservePort(input.bindHost);
  const server = Bun.serve<BrokerData>({
    hostname: input.bindHost,
    port,
    fetch(request, bunServer) {
      if (!bearerMatches(request, input.authToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (url.pathname !== "/devtools/browser/cloud") {
          return new Response("Not found", { status: 404 });
        }
        const upgraded = bunServer.upgrade(request, {
          data: { pending: [], commands: new Map() },
        });
        return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({
          workerBuildId: "browser-use-cloud",
          protocolVersion: 1,
          browserRevision: "Browser Use Cloud",
        });
      }
      if (url.pathname === "/v1/context" && request.method === "POST") {
        return Response.json({
          contextId: null,
          defaultContext: true,
          endpoint: url.origin,
          // Browser Use Cloud runs Chromium on a remote host. Appstrate's
          // read-only workspace mount is therefore not addressable by raw CDP
          // file-input paths. Keep search/login available, but make upload
          // support explicit so publication drivers can fail before submit.
          fileUploadMode: "unsupported",
          // The managed browser emits BrowserUse.captchaSolver* CDP events.
          // The Python bridge enables its watchdog only when this trusted
          // sidecar-owned broker advertises the capability.
          captchaSolver: true,
        });
      }
      if (url.pathname === "/json/version" || url.pathname === "/json/version/") {
        if (!isReadOnlyDevtoolsDiscoveryRequest(request.method, url.pathname, url.search)) {
          return Response.json({ error: "DevTools HTTP mutation is forbidden" }, { status: 403 });
        }
        return Response.json({
          Browser: "Browser Use Cloud",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `${url.origin.replace(/^http/, "ws")}/devtools/browser/cloud`,
        });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        const upstream = new WebSocket(input.upstreamUrl);
        socket.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          for (const pending of socket.data.pending.splice(0)) upstream.send(pending);
        };
        upstream.onmessage = (event) => {
          try {
            const response = JSON.parse(String(event.data)) as {
              id?: number;
              result?: { targetId?: string; success?: boolean };
              error?: unknown;
            };
            if (typeof response.id === "number") {
              const command = socket.data.commands.get(response.id);
              if (command) {
                socket.data.commands.delete(response.id);
                if (command.method === "Target.createTarget") {
                  pendingPageCreations = Math.max(0, pendingPageCreations - 1);
                  if (!response.error && response.result?.targetId) pageTargets += 1;
                } else if (
                  command.method === "Target.closeTarget" &&
                  !response.error &&
                  command.targetId
                ) {
                  pageTargets = Math.max(0, pageTargets - 1);
                }
              }
            }
          } catch {
            // Non-JSON protocol payloads are relayed unchanged.
          }
          socket.send(event.data as string | ArrayBuffer);
        };
        upstream.onerror = () => socket.close(1011, "upstream CDP failed");
        upstream.onclose = () => socket.close();
      },
      message(socket, message) {
        const outgoing = typeof message === "string" ? message : Buffer.from(message);
        const bytes = typeof outgoing === "string" ? Buffer.byteLength(outgoing) : outgoing.length;
        if (bytes > MAX_CDP_MESSAGE_BYTES) {
          socket.close(1009, "CDP message too large");
          return;
        }
        try {
          const command = JSON.parse(String(outgoing)) as {
            id?: number;
            method?: string;
            params?: { targetId?: string; browserContextId?: string };
          };
          if (!hasValidCdpCommandEnvelope(command.method, command.id)) {
            socket.close(1008, "invalid CDP command envelope");
            return;
          }
          if (socket.data.commands.has(command.id!)) {
            socket.send(JSON.stringify({ id: command.id, error: { message: "duplicate CDP id" } }));
            return;
          }
          if (socket.data.commands.size >= MAX_INFLIGHT_CDP_COMMANDS) {
            socket.close(1008, "too many in-flight CDP commands");
            return;
          }
          if (
            (command.method === "Page.navigate" || command.method === "Target.createTarget") &&
            !isAllowedCloudNavigation(
              (command.params as { url?: unknown } | undefined)?.url,
              input.allowedOrigins,
            )
          ) {
            socket.send(
              JSON.stringify({
                id: command.id,
                error: { message: "navigation origin is not authorized" },
              }),
            );
            return;
          }
          const denial = browserCommandDenial({
            method: command.method!,
            browserContextId: command.params?.browserContextId,
            activeContext: DEFAULT_BROWSER_CONTEXT,
            pageTargets,
            pendingPageCreations,
            maxPages: input.maxPages,
          });
          if (denial) {
            socket.send(JSON.stringify({ id: command.id, error: { message: denial } }));
            return;
          }
          if (command.method === "Target.createTarget") pendingPageCreations += 1;
          socket.data.commands.set(command.id!, {
            method: command.method!,
            ...(command.params?.targetId ? { targetId: command.params.targetId } : {}),
          });
        } catch {
          socket.close(1008, "invalid CDP command");
          return;
        }
        if (socket.data.upstream?.readyState === WebSocket.OPEN) {
          socket.data.upstream.send(outgoing);
        } else if (socket.data.pending.length < MAX_PENDING_CDP_MESSAGES) {
          socket.data.pending.push(outgoing);
        } else {
          socket.close(1008, "too many pending CDP messages");
        }
      },
      close(socket) {
        sockets.delete(socket);
        for (const command of socket.data.commands.values()) {
          if (command.method === "Target.createTarget") {
            pendingPageCreations = Math.max(0, pendingPageCreations - 1);
          }
        }
        socket.data.commands.clear();
        socket.data.upstream?.close();
        socket.data.pending.length = 0;
      },
    },
  });
  return {
    endpoint: `http://${input.advertisedHost}:${server.port}`,
    close: async () => {
      for (const socket of sockets) socket.close(1001, "provider shutdown");
      server.stop(true);
    },
  };
}

function parseCloudSession(value: unknown): CloudSession {
  if (!value || typeof value !== "object") {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned a malformed session");
  }
  const raw = value as { id?: unknown; cdpUrl?: unknown; liveUrl?: unknown };
  if (
    typeof raw.id !== "string" ||
    !/^[0-9a-f-]{16,64}$/i.test(raw.id) ||
    typeof raw.cdpUrl !== "string" ||
    raw.cdpUrl.length > 4096
  ) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned a malformed session");
  }
  const cdp = new URL(raw.cdpUrl);
  if (
    (cdp.protocol !== "wss:" && cdp.protocol !== "https:") ||
    cdp.username ||
    cdp.password ||
    !isBrowserUseHost(cdp.hostname)
  ) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned an unsafe CDP URL");
  }
  return {
    id: raw.id,
    cdpUrl: raw.cdpUrl,
    liveUrl: parseCloudInteractionUrl(raw.liveUrl),
  };
}

async function resolveCloudWebSocketUrl(cdpUrl: string, fetchFn: typeof fetch): Promise<string> {
  const endpoint = new URL(cdpUrl);
  if (endpoint.protocol === "wss:") return endpoint.toString();

  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/json/version`;
  const response = await fetchFn(endpoint, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `BROWSER_UNAVAILABLE: Browser Use Cloud CDP discovery returned ${response.status}`,
    );
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || body.webSocketDebuggerUrl.length > 4096) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned malformed CDP discovery");
  }
  const websocket = new URL(body.webSocketDebuggerUrl);
  if (
    websocket.protocol !== "wss:" ||
    websocket.username ||
    websocket.password ||
    !isBrowserUseHost(websocket.hostname)
  ) {
    throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud returned an unsafe CDP WebSocket URL");
  }
  return websocket.toString();
}

export function createBrowserUseCloudProvider(
  deps: { env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {},
): BrowserProvider {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const apiKey = env.BROWSER_USE_API_KEY;
  const maxConcurrent = Number(env.BROWSER_MAX_CONCURRENT ?? 4);
  const timeoutMinutes = Number(env.BROWSER_USE_CLOUD_TIMEOUT_MINUTES ?? 15);
  const customProxy = parseCloudCustomProxy(env);
  const configuredProxyCountryCode = env.BROWSER_USE_CLOUD_PROXY_COUNTRY || undefined;
  if (customProxy && configuredProxyCountryCode) {
    throw new Error(
      "BROWSER_USE_CLOUD_PROXY_COUNTRY cannot be combined with a Browser Use Cloud custom proxy",
    );
  }
  const proxyCountryCode = configuredProxyCountryCode ?? "fr";
  const profileId = parseCloudProfileId(env);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) {
    throw new Error("BROWSER_MAX_CONCURRENT must be an integer from 1 to 128");
  }
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240) {
    throw new Error("BROWSER_USE_CLOUD_TIMEOUT_MINUTES must be an integer from 5 to 240");
  }
  if (!/^[a-z]{2}$/.test(proxyCountryCode)) {
    throw new Error("BROWSER_USE_CLOUD_PROXY_COUNTRY must be a lowercase ISO country code");
  }
  const active = new Map<string, { session: CloudSession; broker: CloudBroker }>();

  async function stopCloudSession(sessionId: string): Promise<void> {
    if (!apiKey) return;
    await fetchFn(`${CLOUD_API}/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Browser-Use-API-Key": apiKey },
      body: JSON.stringify({ action: "stop" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  return {
    id: "browser-use-cloud",
    async prepare(runId) {
      if (!apiKey || apiKey.length < 16) {
        throw new Error(
          "BROWSER_UNAVAILABLE: BROWSER_USE_API_KEY is required by browser-use-cloud",
        );
      }
      return { runId };
    },
    async spawn(options: SpawnBrowserOptions): Promise<BrowserHandle> {
      if (!apiKey) throw new Error("BROWSER_UNAVAILABLE: Browser Use Cloud is not configured");
      // Remote browsers do not traverse Appstrate's host egress gateway, so
      // this provider is deliberately limited to reviewed system drivers.
      // Ordinary org-owned browser automation stays on local Docker/process,
      // where subresource origin and SSRF enforcement remain complete.
      if (options.spec.purpose !== "connection-acquisition" || !options.spec.trustedDriver) {
        throw new Error(
          "BROWSER_POLICY_DENIED: browser-use-cloud is restricted to trusted connection drivers",
        );
      }
      if (active.size >= maxConcurrent) {
        throw new Error(
          `BROWSER_RESOURCE_LIMIT: cloud browser capacity reached (${active.size}/${maxConcurrent})`,
        );
      }
      const response = await fetchFn(CLOUD_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Browser-Use-API-Key": apiKey },
        body: JSON.stringify({
          timeout: timeoutMinutes,
          ...(customProxy ? { customProxy } : { proxyCountryCode }),
          ...(profileId ? { profileId } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 201) {
        throw new Error(`BROWSER_UNAVAILABLE: Browser Use Cloud returned ${response.status}`);
      }
      const rawSession = await response.json();
      let session: CloudSession;
      try {
        session = parseCloudSession(rawSession);
      } catch (error) {
        const unsafeId =
          rawSession &&
          typeof rawSession === "object" &&
          typeof (rawSession as { id?: unknown }).id === "string" &&
          /^[0-9a-f-]{16,64}$/i.test((rawSession as { id: string }).id)
            ? (rawSession as { id: string }).id
            : null;
        if (unsafeId) await stopCloudSession(unsafeId);
        throw error;
      }
      const authToken = randomBytes(32).toString("base64url");
      let broker: CloudBroker | undefined;
      try {
        const upstreamUrl = await resolveCloudWebSocketUrl(session.cdpUrl, fetchFn);
        const docker = env.INTEGRATION_RUNTIME_ADAPTER === "docker";
        broker = await createBrowserUseCloudBroker({
          upstreamUrl,
          authToken,
          maxPages: options.resources.maxPages,
          allowedOrigins: options.spec.allowedOrigins,
          bindHost: docker ? "0.0.0.0" : "127.0.0.1",
          advertisedHost: docker ? "sidecar" : "127.0.0.1",
        });
        active.set(session.id, { session, broker });
        return {
          id: session.id,
          endpoint: broker.endpoint,
          authToken,
          interactionUrl: session.liveUrl,
          workerBuildId: "browser-use-cloud",
          protocolVersion: 1,
          browserRevision: "Browser Use Cloud",
          diagnosticId: session.id,
        };
      } catch (error) {
        await broker?.close().catch(() => undefined);
        await stopCloudSession(session.id);
        throw error;
      }
    },
    async stop(handle) {
      const item = active.get(handle.id);
      if (!item) return;
      active.delete(handle.id);
      await item.broker.close().catch(() => undefined);
      await stopCloudSession(item.session.id);
    },
    async shutdown() {
      for (const [id, item] of [...active]) {
        active.delete(id);
        await item.broker.close().catch(() => undefined);
        await stopCloudSession(item.session.id);
      }
    },
  };
}

registerBrowserProvider({
  id: "browser-use-cloud",
  create: createBrowserUseCloudProvider,
});
