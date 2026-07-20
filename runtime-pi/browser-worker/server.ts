// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserCommandDenial,
  DEFAULT_BROWSER_CONTEXT,
  hasValidCdpCommandEnvelope,
  isCookieDomainAllowed,
  isReadOnlyDevtoolsDiscoveryRequest,
  parseAllowedOrigins,
} from "./policy.ts";

const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CDP_MESSAGE_BYTES = 1024 * 1024;
const MAX_PENDING_CDP_MESSAGES = 1024;
const MAX_INFLIGHT_CDP_COMMANDS = 2048;
const WORKER_BUILD_ID = process.env.APPSTRATE_BROWSER_WORKER_BUILD_ID ?? "development";
const WORKER_TOKEN = process.env.BROWSER_WORKER_TOKEN ?? "";
const GATEWAY_URL = process.env.BROWSER_GATEWAY_URL ?? "";
const GATEWAY_TOKEN = process.env.BROWSER_GATEWAY_TOKEN ?? "";
const MAX_PAGES = Number(process.env.BROWSER_MAX_PAGES ?? 4);
const GATEWAY_AUTH_PROXY_PORT = Number(process.env.BROWSER_GATEWAY_AUTH_PROXY_PORT ?? 0);
const DEVTOOLS_PORT = Number(process.env.BROWSER_DEVTOOLS_PORT ?? 0);
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.BROWSER_ALLOWED_ORIGINS_JSON);

if (
  Buffer.byteLength(WORKER_TOKEN) < 32 ||
  Buffer.byteLength(GATEWAY_TOKEN) < 32 ||
  !Number.isInteger(MAX_PAGES) ||
  MAX_PAGES < 1 ||
  MAX_PAGES > 16 ||
  !Number.isInteger(GATEWAY_AUTH_PROXY_PORT) ||
  GATEWAY_AUTH_PROXY_PORT < 0 ||
  GATEWAY_AUTH_PROXY_PORT > 65_535 ||
  !Number.isInteger(DEVTOOLS_PORT) ||
  DEVTOOLS_PORT < 0 ||
  DEVTOOLS_PORT > 65_535 ||
  (GATEWAY_AUTH_PROXY_PORT !== 0 && GATEWAY_AUTH_PROXY_PORT === DEVTOOLS_PORT) ||
  !/^[A-Za-z0-9._@/+:-]{1,128}$/.test(WORKER_BUILD_ID)
) {
  throw new Error("browser worker authentication or page-limit configuration is invalid");
}

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(WORKER_TOKEN, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function findChromium(): Promise<string> {
  const candidates = [
    process.env.APPSTRATE_BROWSER_EXECUTABLE,
    process.env.BROWSER_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the small explicit allowlist. No download or PATH scan.
    }
  }
  throw new Error("BROWSER_UNAVAILABLE: no supported Chromium executable was found");
}

interface GatewayAuthProxy {
  readonly port: number;
  close(): Promise<void>;
}

/** Local-only shim that adds gateway authentication on Chromium's behalf. */
async function createGatewayAuthProxy(port: number): Promise<GatewayAuthProxy> {
  const gateway = new URL(GATEWAY_URL);
  if (gateway.protocol !== "http:")
    throw new Error("browser gateway control channel must use http");
  const sockets = new Set<Duplex>();
  const server = createHttpServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (request, client, head) => {
    const target = request.url ?? "";
    const upstream = netConnect(Number(gateway.port), gateway.hostname);
    sockets.add(client);
    sockets.add(upstream);
    const cleanup = () => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.once("close", cleanup);
    upstream.once("close", cleanup);
    upstream.once("connect", () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${GATEWAY_TOKEN}\r\n\r\n`,
      );
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 16_384) {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
        return;
      }
      const combined = Buffer.concat(chunks);
      const end = combined.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.off("data", onData);
      const status = Number(
        /^HTTP\/1\.[01]\s+(\d{3})/.exec(combined.subarray(0, end).toString("latin1"))?.[1] ?? 0,
      );
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status || 502} Gateway Rejected\r\n\r\n`);
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const remaining = combined.subarray(end + 4);
      if (remaining.length > 0) client.write(remaining);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    upstream.on("data", onData);
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway shim did not bind");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForDevtools(
  profile: string,
  configuredPort: number,
): Promise<{ port: number; browserPath: string }> {
  if (configuredPort !== 0) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const version = (await fetch(`http://127.0.0.1:${configuredPort}/json/version`).then(
          (response) => response.json(),
        )) as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) {
          return {
            port: configuredPort,
            browserPath: new URL(version.webSocketDebuggerUrl).pathname,
          };
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("BROWSER_UNAVAILABLE: Chromium did not bind the fixed DevTools endpoint");
  }
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = (await readFile(path, "utf8")).trim().split("\n");
      if (port && browserPath) return { port: Number(port), browserPath };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("BROWSER_UNAVAILABLE: Chromium did not publish a DevTools endpoint");
}

function rewriteWebSocketUrls(value: unknown, workerOrigin: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteWebSocketUrls(item, workerOrigin));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "webSocketDebuggerUrl" && typeof entry === "string") {
      const url = new URL(entry);
      output[key] = workerOrigin.replace(/^http/, "ws") + url.pathname + url.search;
    } else {
      output[key] = rewriteWebSocketUrls(entry, workerOrigin);
    }
  }
  return output;
}

interface BrokerData {
  upstreamUrl: string;
  upstream?: WebSocket;
  pending: Array<string | Buffer>;
  commands: Map<number, { method: string; targetId?: string }>;
}

let nextCdpCallId = 10;

async function cdpCall<T>(browserWs: string, method: string, params: object = {}): Promise<T> {
  const ws = new WebSocket(browserWs);
  const id = nextCdpCallId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP ${method} transport failed`));
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: T;
        error?: { message?: string };
      };
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(message.error.message ?? `CDP ${method} failed`));
      else resolve(message.result as T);
    };
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("browser worker request body is too large");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES)
    throw new Error("browser worker request body is too large");
  if (bytes.byteLength === 0) return {};
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("browser worker request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

const executable = await findChromium();
const gatewayProxy = await createGatewayAuthProxy(GATEWAY_AUTH_PROXY_PORT);
const profile = await mkdtemp(join(tmpdir(), "appstrate-browser-profile-"));
const chromium: ChildProcess = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${gatewayProxy.port}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--disable-features=DnsOverHttps,BackgroundSync,MediaRouter",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-crash-reporter",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
  ],
  { detached: true, stdio: "ignore" },
);
const chromiumExited = new Promise<void>((resolve) => {
  chromium.once("exit", () => resolve());
});

let activeContext: string | null = null;
let contextRetired = false;
const pageTargets = new Set<string>();
let pendingPageCreations = 0;

function signalChromium(signal: NodeJS.Signals): void {
  const pid = chromium.pid;
  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  chromium.kill(signal);
}

async function stopChromium(): Promise<void> {
  signalChromium("SIGTERM");
  const exited = await Promise.race([
    chromiumExited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (exited) return;
  signalChromium("SIGKILL");
  await Promise.race([chromiumExited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
}

async function initializeChromiumControl(): Promise<{
  devtools: { port: number; browserPath: string };
  browserWs: string;
  version: { Browser?: string; "User-Agent"?: string };
  targetMonitor: WebSocket;
}> {
  const devtools = await waitForDevtools(profile, DEVTOOLS_PORT);
  const browserWs = `ws://127.0.0.1:${devtools.port}${devtools.browserPath}`;
  const version = (await fetch(`http://127.0.0.1:${devtools.port}/json/version`).then((res) =>
    res.json(),
  )) as { Browser?: string; "User-Agent"?: string };

  // A trusted monitor observes popup-created targets too, not only explicit
  // Target.createTarget commands passing through the broker. Any target beyond
  // the profile ceiling is closed immediately. Failure to establish this
  // monitor fails worker startup rather than silently dropping the page bound.
  const targetMonitor = new WebSocket(browserWs);
  const earlyTargetEvents: string[] = [];
  const handleTargetMonitorMessage = (raw: string): void => {
    let message: {
      method?: string;
      params?: { targetId?: string; targetInfo?: { targetId?: string; type?: string } };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.method === "Target.targetCreated" && message.params?.targetInfo?.type === "page") {
      const targetId = message.params.targetInfo.targetId;
      if (!targetId) return;
      pageTargets.add(targetId);
      if (pageTargets.size > MAX_PAGES) {
        void cdpCall(browserWs, "Target.closeTarget", { targetId }).catch(() => {});
      }
    } else if (message.method === "Target.targetDestroyed" && message.params?.targetId) {
      pageTargets.delete(message.params.targetId);
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("browser target monitor startup timed out")),
        5_000,
      );
      targetMonitor.onopen = () => {
        targetMonitor.send(
          JSON.stringify({
            id: 1,
            method: "Target.setDiscoverTargets",
            params: { discover: true },
          }),
        );
      };
      targetMonitor.onmessage = (event) => {
        const raw = String(event.data);
        let response: { id?: number; error?: { message?: string } };
        try {
          response = JSON.parse(raw);
        } catch {
          earlyTargetEvents.push(raw);
          return;
        }
        if (response.id !== 1) {
          earlyTargetEvents.push(raw);
          return;
        }
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error.message ?? "target discovery failed"));
        else resolve();
      };
      targetMonitor.onerror = () => {
        clearTimeout(timer);
        reject(new Error("browser target monitor transport failed"));
      };
      targetMonitor.onclose = () => {
        clearTimeout(timer);
        reject(new Error("browser target monitor closed during startup"));
      };
    });
    targetMonitor.onmessage = (event) => {
      handleTargetMonitorMessage(String(event.data));
    };
    for (const raw of earlyTargetEvents) handleTargetMonitorMessage(raw);
    const initialTargets = await cdpCall<{
      targetInfos?: Array<{ targetId?: string; type?: string }>;
    }>(browserWs, "Target.getTargets");
    for (const target of initialTargets.targetInfos ?? []) {
      if (target.type === "page" && target.targetId) pageTargets.add(target.targetId);
    }
    if (pageTargets.size > MAX_PAGES) {
      throw new Error("browser page ceiling was exceeded during startup");
    }
    return { devtools, browserWs, version, targetMonitor };
  } catch (error) {
    targetMonitor.close();
    throw error;
  }
}

let control: Awaited<ReturnType<typeof initializeChromiumControl>>;
try {
  control = await initializeChromiumControl();
} catch (error) {
  await stopChromium();
  await gatewayProxy.close().catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  throw error;
}
const { devtools, browserWs, version, targetMonitor } = control;

const server = Bun.serve<BrokerData>({
  hostname: process.env.BROWSER_WORKER_HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  async fetch(req, bunServer) {
    if (!authorized(req)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!url.pathname.startsWith("/devtools/")) return new Response("Not found", { status: 404 });
      const upgraded = bunServer.upgrade(req, {
        data: {
          upstreamUrl: `ws://127.0.0.1:${devtools.port}${url.pathname}${url.search}`,
          pending: [],
          commands: new Map(),
        },
      });
      return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        workerBuildId: WORKER_BUILD_ID,
        protocolVersion: PROTOCOL_VERSION,
        browserRevision: version.Browser ?? "unknown",
      });
    }
    if (url.pathname === "/json" || url.pathname.startsWith("/json/")) {
      if (!isReadOnlyDevtoolsDiscoveryRequest(req.method, url.pathname, url.search)) {
        return Response.json({ error: "DevTools HTTP mutation is forbidden" }, { status: 403 });
      }
      const response = await fetch(`http://127.0.0.1:${devtools.port}${url.pathname}`, {
        method: req.method,
      });
      const body = await response.json();
      return Response.json(rewriteWebSocketUrls(body, url.origin), { status: response.status });
    }
    if (url.pathname === "/v1/context" && req.method === "POST") {
      if (activeContext) {
        return Response.json(
          {
            error: "context already exists",
            fileUploadMode: "shared-filesystem",
            captchaSolver: false,
          },
          { status: 409 },
        );
      }
      if (contextRetired) {
        return Response.json({ error: "context lifecycle is complete" }, { status: 410 });
      }
      // One ephemeral worker exists per integration, so the Chromium default
      // profile is already the isolation boundary. Owning it here keeps the
      // public CDP endpoint compatible with Playwright's default context;
      // Playwright cannot attach to an incognito context created out-of-band.
      activeContext = DEFAULT_BROWSER_CONTEXT;
      return Response.json({
        contextId: null,
        defaultContext: true,
        endpoint: url.origin,
        fileUploadMode: "shared-filesystem",
        captchaSolver: false,
      });
    }
    if (url.pathname === "/v1/context/state" && req.method === "PUT") {
      if (!activeContext)
        return Response.json({ error: "context does not exist" }, { status: 409 });
      const body = await readJsonBody(req);
      const cookies = Array.isArray(body.cookies) ? body.cookies : [];
      for (const cookie of cookies) {
        const rawDomain =
          cookie &&
          typeof cookie === "object" &&
          typeof (cookie as { domain?: unknown }).domain === "string"
            ? (cookie as { domain: string }).domain
            : "";
        if (!isCookieDomainAllowed(rawDomain, ALLOWED_ORIGINS)) {
          return Response.json(
            { error: "state contains a cookie outside allowed origins" },
            { status: 400 },
          );
        }
      }
      await cdpCall(browserWs, "Storage.setCookies", { cookies });
      return Response.json({ restored: true });
    }
    if (url.pathname === "/v1/context/state" && req.method === "GET") {
      if (!activeContext)
        return Response.json({ error: "context does not exist" }, { status: 409 });
      const state = await cdpCall<{ cookies: unknown[] }>(browserWs, "Storage.getCookies");
      return Response.json({
        cookies: state.cookies,
        localStorage: {},
        origins: ALLOWED_ORIGINS,
        userAgent: version["User-Agent"] ?? "unknown",
        browserRevision: version.Browser ?? "unknown",
        protocolVersion: PROTOCOL_VERSION,
        workerBuildId: WORKER_BUILD_ID,
      });
    }
    if (url.pathname === "/v1/context" && req.method === "DELETE") {
      if (activeContext) {
        for (const targetId of [...pageTargets]) {
          await cdpCall(browserWs, "Target.closeTarget", { targetId }).catch(() => {});
        }
        await cdpCall(browserWs, "Storage.clearCookies");
        activeContext = null;
        // Default-context DOM storage cannot be synchronously cleared for an
        // origin that never created a storage key (Chromium returns -32603).
        // Retire the one-shot lifecycle instead: no later driver can reactivate
        // this profile, and provider teardown deletes the whole profile.
        contextRetired = true;
      }
      return Response.json({ closed: true });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket(ws.data.upstreamUrl);
      ws.data.upstream = upstream;
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const message of ws.data.pending.splice(0)) upstream.send(message);
      };
      upstream.onmessage = (event) => {
        const raw = String(event.data);
        try {
          const response = JSON.parse(raw) as {
            id?: number;
            result?: { targetId?: string; success?: boolean };
            error?: unknown;
          };
          if (typeof response.id === "number") {
            const command = ws.data.commands.get(response.id);
            if (command) {
              ws.data.commands.delete(response.id);
              if (command.method === "Target.createTarget") {
                pendingPageCreations = Math.max(0, pendingPageCreations - 1);
                if (!response.error && response.result?.targetId) {
                  pageTargets.add(response.result.targetId);
                }
              } else if (
                command.method === "Target.closeTarget" &&
                !response.error &&
                command.targetId
              ) {
                pageTargets.delete(command.targetId);
              }
            }
          }
        } catch {
          // Non-JSON CDP data is passed through unchanged.
        }
        ws.send(event.data as string | ArrayBuffer);
      };
      upstream.onerror = () => ws.close(1011, "upstream CDP failed");
      upstream.onclose = () => ws.close();
    },
    message(ws, message) {
      const outgoing = typeof message === "string" ? message : Buffer.from(message);
      const outgoingBytes =
        typeof outgoing === "string" ? Buffer.byteLength(outgoing) : outgoing.byteLength;
      if (outgoingBytes > MAX_CDP_MESSAGE_BYTES) {
        ws.close(1009, "CDP message too large");
        return;
      }
      try {
        const command = JSON.parse(String(outgoing)) as {
          id?: number;
          method?: string;
          params?: { targetId?: string; browserContextId?: string };
        };
        if (!hasValidCdpCommandEnvelope(command.method, command.id)) {
          ws.close(1008, "invalid CDP command envelope");
          return;
        }
        if (typeof command.id === "number" && typeof command.method === "string") {
          if (ws.data.commands.has(command.id)) {
            ws.send(JSON.stringify({ id: command.id, error: { message: "duplicate CDP id" } }));
            return;
          }
          if (ws.data.commands.size >= MAX_INFLIGHT_CDP_COMMANDS) {
            ws.close(1008, "too many in-flight CDP commands");
            return;
          }
          const denial = browserCommandDenial({
            method: command.method,
            browserContextId: command.params?.browserContextId,
            activeContext,
            pageTargets: pageTargets.size,
            pendingPageCreations,
            maxPages: MAX_PAGES,
          });
          if (denial) {
            ws.send(
              JSON.stringify({
                id: command.id,
                error: { message: denial },
              }),
            );
            return;
          }
          if (command.method === "Target.createTarget") pendingPageCreations += 1;
          ws.data.commands.set(command.id, {
            method: command.method,
            ...(command.params?.targetId ? { targetId: command.params.targetId } : {}),
          });
        }
      } catch {
        ws.close(1008, "invalid CDP command");
        return;
      }
      if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(outgoing);
      else if (ws.data.pending.length < MAX_PENDING_CDP_MESSAGES) ws.data.pending.push(outgoing);
      else ws.close(1008, "too many pending CDP messages");
    },
    close(ws) {
      for (const command of ws.data.commands.values()) {
        if (command.method === "Target.createTarget") {
          pendingPageCreations = Math.max(0, pendingPageCreations - 1);
        }
      }
      ws.data.commands.clear();
      ws.data.upstream?.close();
      ws.data.pending.length = 0;
    },
  },
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop(true);
  targetMonitor.close();
  await stopChromium();
  await gatewayProxy.close().catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
chromium.once("exit", () => {
  if (!shuttingDown) void shutdown().then(() => process.exit(1));
});

if (chromium.exitCode !== null || chromium.signalCode !== null) {
  await shutdown();
  throw new Error("BROWSER_UNAVAILABLE: Chromium exited during worker startup");
}

process.stdout.write(
  `APPSTRATE_BROWSER_WORKER_READY:${JSON.stringify({
    endpoint: `http://127.0.0.1:${server.port}`,
    workerBuildId: WORKER_BUILD_ID,
    protocolVersion: PROTOCOL_VERSION,
    browserRevision: version.Browser ?? "unknown",
    nonce: randomBytes(8).toString("hex"),
  })}\n`,
);
