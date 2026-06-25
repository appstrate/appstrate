// SPDX-License-Identifier: Apache-2.0

import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import type {
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
  RequestOptions,
} from "node:http";
import {
  isBlockedHost,
  resolveAndCheckHost,
  OUTBOUND_TIMEOUT_MS,
  HOP_BY_HOP_HEADERS,
  type HostResolver,
  type SidecarConfig,
} from "./helpers.ts";
import {
  parseConnectTarget,
  netConnectWithTimeout,
  relaySockets,
  TUNNEL_IDLE_TIMEOUT_MS,
} from "./connect-tunnel.ts";
import { logger } from "./logger.ts";

export interface ForwardProxyDeps {
  config: SidecarConfig;
  listenPort?: number; // default 8081 — tests use 0 (ephemeral)
  listenHost?: string; // default "0.0.0.0" — tests use "127.0.0.1"
  isBlockedHostFn?: typeof isBlockedHost; // injectable for testing pass-through
  /**
   * Injectable DNS resolver for the rebind guard (tests stub it; production
   * uses the system resolver). Only consulted for non-IP-literal targets on
   * the DIRECT paths — upstream-proxy-chained traffic resolves remotely and
   * the trusted platform host keeps its name-based connect.
   */
  resolveHostFn?: HostResolver;
}

export interface ForwardProxyResult {
  server: HttpServer;
  ready: Promise<void>; // resolves when the port is bound
  readySync: boolean; // synchronous check
  address: () => { port: number; host: string };
}

export function createForwardProxy(deps: ForwardProxyDeps): ForwardProxyResult {
  const { config } = deps;
  const listenPort = deps.listenPort ?? 8081;
  const listenHost = deps.listenHost ?? "0.0.0.0";
  const isBlockedHostFn = deps.isBlockedHostFn ?? isBlockedHost;
  const resolveHostFn = deps.resolveHostFn;

  const MAX_CONNECT_HEADER_SIZE = 16_384; // 16 KB — CONNECT response headers should be tiny

  function getUpstreamProxy(
    targetHost?: string,
  ): { host: string; port: number; auth: string | null } | null {
    if (!config.proxyUrl) return null;
    // Bypass the upstream proxy when the target is the platform host.
    // Same rationale as isAllowedHost() below: platform traffic is internal,
    // trusted by construction (HMAC-signed run events scoped to a single
    // run). Residential / datacenter egress proxies (Decodo, Bright Data,
    // Smartproxy, …) typically refuse RFC1918 or docker-bridge hostnames
    // as "restricted targets" with a 403 — which would crash the agent at
    // bootstrap, since `emitRuntimeReady` POSTs to the platform sink as
    // its very first action. Keeping platform traffic off the upstream
    // proxy preserves the proxy's purpose (mask outbound IP for tracked
    // upstreams) without breaking internal comms.
    if (targetHost) {
      const platformHost = getPlatformHost();
      if (platformHost && targetHost.toLowerCase() === platformHost) return null;
    }
    try {
      const url = new URL(config.proxyUrl);
      // HTTPS upstream proxies are not supported — the forward proxy connects via plain TCP.
      if (url.protocol === "https:") {
        logger.warn(
          "HTTPS upstream proxy not supported, connection will use plain TCP — proxy may reject",
          { proxyUrl: url.origin },
        );
      }
      return {
        host: url.hostname,
        port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
        auth: url.username
          ? "Basic " +
            btoa(decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password))
          : null,
      };
    } catch {
      logger.warn("Invalid proxy URL, ignoring", { proxyUrl: config.proxyUrl });
      return null;
    }
  }

  // Tunnel parsing / connect-with-timeout / relay live in connect-tunnel.ts —
  // shared verbatim with the per-integration egress listener (#543). Local
  // alias keeps the call sites below unchanged.
  const relay = (s1: Socket, s2: Socket) => relaySockets(s1, s2, TUNNEL_IDLE_TIMEOUT_MS);

  /** Strip hop-by-hop headers + Connection-listed headers from incoming request. */
  function forwardHeaders(
    raw: IncomingMessage["headers"],
  ): Record<string, string | string[] | undefined> {
    // Collect any extra hop-by-hop names declared in the Connection header
    const connectionExtra = new Set(
      (typeof raw.connection === "string" ? raw.connection : "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );

    const out: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || connectionExtra.has(lower)) continue;
      out[key] = value;
    }
    return out;
  }

  // The platform API is a trusted destination: the agent can only send
  // HMAC-signed messages there (the run secret is scoped to a single run).
  // In local dev the platform URL resolves to `host.docker.internal`, which
  // is in the SSRF blocklist — exempt that specific host so sink/finalize
  // traffic can reach the platform. Other internal hosts remain blocked.
  function getPlatformHost(): string | null {
    try {
      return new URL(config.platformApiUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  function isPlatformHost(hostname: string): boolean {
    const platformHost = getPlatformHost();
    return platformHost !== null && hostname.toLowerCase() === platformHost;
  }

  // Per-run egress allowlist (vend-mode runs, e.g. the Codex CLI). The allowlist
  // lives ON the vend LLM config — it exists if and only if this is a vend run —
  // so the vend-egress lock and its host list derive from one source. When set,
  // outbound traffic is locked to these hosts only — the real upstream token
  // lives in-container, so a wide-open egress would let it be exfiltrated.
  // Normalised once; a target matches by exact name or parent-domain suffix.
  const egressAllowlist = (config.llm?.authMode === "vend" ? config.llm.egressAllowlist : [])
    .map((h) => h.toLowerCase())
    .filter(Boolean);

  function isOnAllowlist(hostname: string): boolean {
    return egressAllowlist.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    );
  }

  function isAllowedHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    // The platform host is always reachable (HMAC-scoped internal traffic),
    // even under an allowlist — the agent's sink/finalize POSTs must get out.
    if (isPlatformHost(h)) return true;
    if (isBlockedHostFn(h)) return false;
    // Allowlist mode (vend runs): everything not on the list is refused.
    if (egressAllowlist.length > 0) return isOnAllowlist(h);
    // Default posture: SSRF-block-only (every public host allowed).
    return true;
  }

  // Vend-egress port pin. A vend run holds the REAL subscription token
  // in-container, so its DIRECT egress must be locked tight: the host-only
  // allowlist (`isAllowedHost`) would still let the agent CONNECT to
  // `chatgpt.com:<any-port>` and tunnel arbitrary protocols out. When an
  // allowlist is present (the vend-run signal — the allowlist lives on the vend
  // config, so a non-empty list iff `authMode === "vend"`), refuse any non-443 port on
  // allowlisted hosts. The platform host is exempt — it is internal HMAC-scoped
  // traffic on its own port, governed by `isPlatformHost`, not the allowlist.
  const vendEgressActive = egressAllowlist.length > 0;

  function isAllowedPort(hostname: string, port: number): boolean {
    if (!vendEgressActive) return true;
    if (isPlatformHost(hostname)) return true;
    // Loopback is a dev/test-only target (local echo servers on ephemeral
    // ports); a real vend-egress provider host is never loopback. Exempting it
    // keeps the port pin from breaking local fixtures while still locking every
    // real allowlisted host to :443.
    const h = hostname.toLowerCase();
    if (h === "127.0.0.1" || h === "::1" || h === "localhost") return true;
    return port === 443;
  }

  /**
   * DNS-rebind guard for the DIRECT egress paths (resolve-and-pin): a DNS
   * name whose A/AAAA record points inside (10.x, 169.254.169.254, …) passes
   * the literal `isAllowedHost` check but must NOT reach the boundary.
   * Returns the address to connect to — the PINNED resolved IP for DNS names
   * (so the actual connect can't re-resolve to a different answer), the
   * literal itself for IPs, or `null` when the target must be refused (any
   * blocked record, or resolution failure — fail closed).
   *
   * The trusted platform host is exempt and keeps its name-based connect: in
   * local dev it is `host.docker.internal`/an internal name by design, and
   * platform traffic is HMAC-scoped (same rationale as `isAllowedHost`).
   */
  async function pinDirectTarget(hostname: string): Promise<string | null> {
    if (isPlatformHost(hostname)) return hostname;
    const check = await resolveAndCheckHost(hostname.toLowerCase(), {
      resolve: resolveHostFn,
      isBlockedHostFn,
    });
    return check.blocked ? null : check.pinnedAddress;
  }

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Regular HTTP requests (non-CONNECT) — forward through upstream or direct
    const targetUrl = req.url;
    if (!targetUrl) {
      res.writeHead(400);
      res.end("Missing URL");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.writeHead(400);
      res.end("Invalid URL");
      return;
    }

    // SSRF protection — block requests to internal/private networks,
    // except the trusted platform API (handles local-dev host.docker.internal).
    if (!isAllowedHost(parsed.hostname)) {
      res.writeHead(403);
      res.end("Blocked: internal network");
      return;
    }

    // Vend-egress port pin (see isAllowedPort) — a vend run may only egress to
    // :443 on allowlisted hosts, so an in-container token can't be tunnelled
    // out over an arbitrary port.
    if (!isAllowedPort(parsed.hostname, parseInt(parsed.port) || 80)) {
      res.writeHead(403);
      res.end("Blocked: port not allowed for this run");
      return;
    }

    // Resolve the upstream proxy with the target hostname — internal platform
    // traffic bypasses the upstream proxy (see getUpstreamProxy docstring).
    const upstream = getUpstreamProxy(parsed.hostname);

    const cleaned = forwardHeaders(req.headers);

    const forward = (options: RequestOptions) => {
      const proxyReq = httpRequest(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      });

      // Timeout — abort if the target or upstream proxy hangs
      proxyReq.setTimeout(OUTBOUND_TIMEOUT_MS, () => {
        proxyReq.destroy(new Error(`Request timeout after ${OUTBOUND_TIMEOUT_MS}ms`));
      });

      // Clean up if either side breaks
      req.on("error", () => {
        proxyReq.destroy();
      });
      res.on("error", () => {
        proxyReq.destroy();
      });
      proxyReq.on("error", (err) => {
        logger.error("Forward proxy HTTP error", { target: targetUrl, error: err.message });
        if (!res.headersSent) res.writeHead(502);
        res.end("Proxy error");
      });

      req.pipe(proxyReq);
    };

    if (upstream) {
      // Chained: the upstream proxy resolves the target remotely — no local
      // DNS to pin. Connect to the proxy itself.
      forward({
        hostname: upstream.host,
        port: upstream.port,
        path: targetUrl,
        method: req.method,
        headers: {
          ...cleaned,
          host: parsed.host,
          ...(upstream.auth ? { "Proxy-Authorization": upstream.auth } : {}),
        },
      });
      return;
    }

    // Direct: resolve-and-pin to close the DNS-rebind gap — the literal
    // isAllowedHost() check above does not resolve names. The Host header
    // keeps the original name; only the TCP target is pinned.
    void pinDirectTarget(parsed.hostname).then((pinned) => {
      if (pinned === null) {
        res.writeHead(403);
        res.end("Blocked: internal network");
        return;
      }
      forward({
        hostname: pinned,
        port: parseInt(parsed.port) || 80,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...cleaned, host: parsed.host },
      });
    });
  });

  // CONNECT handler — HTTPS tunneling
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = req.url ?? "";

    // Parse host:port — handles IPv6 bracket notation ([::1]:443)
    const parsedTarget = parseConnectTarget(target);
    if (!parsedTarget) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const { host, port } = parsedTarget;

    // SSRF protection — block CONNECT tunnels to internal/private networks,
    // except the trusted platform API (handles local-dev host.docker.internal).
    if (!isAllowedHost(host)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    // Vend-egress port pin (see isAllowedPort) — refuse a CONNECT tunnel to any
    // non-443 port on an allowlisted host so the in-container token cannot be
    // exfiltrated over an arbitrary tunnelled port.
    if (!isAllowedPort(host, port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    // Resolve the upstream proxy with the target hostname — internal platform
    // traffic bypasses the upstream proxy (see getUpstreamProxy docstring).
    const upstream = getUpstreamProxy(host);

    if (upstream) {
      // Chain through authenticated upstream proxy
      const proxySocket = netConnectWithTimeout(upstream.port, upstream.host, () => {
        let connectReq = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
        if (upstream.auth) connectReq += `Proxy-Authorization: ${upstream.auth}\r\n`;
        connectReq += "\r\n";
        proxySocket.write(connectReq);
      });

      // Accumulate raw Buffers to avoid corrupting binary data after headers
      const chunks: Buffer[] = [];
      let bufferSize = 0;
      let established = false;
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        bufferSize += chunk.length;

        // Guard against oversized headers from misbehaving upstream
        if (bufferSize > MAX_CONNECT_HEADER_SIZE) {
          logger.error("CONNECT header too large from upstream", { target, size: bufferSize });
          proxySocket.off("data", onData);
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
          proxySocket.destroy();
          return;
        }

        const combined = Buffer.concat(chunks);
        const headerEnd = combined.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        // Remove listener BEFORE relay to avoid writing data twice
        proxySocket.off("data", onData);

        const headerStr = combined.subarray(0, headerEnd).toString();
        const status = parseInt(headerStr.split(" ")[1] ?? "0");
        if (status === 200) {
          established = true;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remaining = combined.subarray(headerEnd + 4);
          if (remaining.length) clientSocket.write(remaining);
          if (head.length) proxySocket.write(head);
          relay(clientSocket, proxySocket);
        } else {
          logger.warn("Upstream CONNECT rejected", { target, status });
          clientSocket.write(`HTTP/1.1 ${status} Upstream Rejected\r\n\r\n`);
          clientSocket.destroy();
          proxySocket.destroy();
        }
      };
      proxySocket.on("data", onData);
      proxySocket.on("error", (err) => {
        logger.error("CONNECT upstream error", { target, error: err.message });
        if (!established && !clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
        clientSocket.destroy();
      });
      clientSocket.on("error", () => proxySocket.destroy());
    } else {
      // Direct connection (pass-through). Resolve-and-pin to close the
      // DNS-rebind gap — the literal isAllowedHost() check above does not
      // resolve names. Pinning is safe: this is a blind CONNECT tunnel (no
      // TLS termination here), the client's own handshake carries SNI/Host
      // for the original name. The platform host keeps a name-based connect.
      void pinDirectTarget(host).then((pinned) => {
        if (clientSocket.destroyed) return; // client gave up during resolution
        if (pinned === null) {
          clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        let established = false;
        const targetSocket = netConnectWithTimeout(port, pinned, () => {
          established = true;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) targetSocket.write(head);
          relay(clientSocket, targetSocket);
        });
        targetSocket.on("error", (err) => {
          logger.error("CONNECT direct error", { target, error: err.message });
          // Surface a 502 to the waiting client before tearing down — but only
          // pre-tunnel. Once established, writing into the relayed stream would
          // corrupt it, so just destroy.
          if (!established && !clientSocket.destroyed) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
          clientSocket.destroy();
        });
        clientSocket.on("error", () => targetSocket.destroy());
      });
    }
  });

  server.on("error", (err) => {
    logger.error("Forward proxy server error", { error: err.message });
  });

  let readySyncFlag = false;
  const readyPromise = new Promise<void>((resolve) => {
    server.listen(listenPort, listenHost, () => {
      readySyncFlag = true;
      resolve();
    });
  });

  return {
    server,
    ready: readyPromise,
    get readySync() {
      return readySyncFlag;
    },
    address: () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        return { port: addr.port, host: addr.address };
      }
      return { port: listenPort, host: listenHost };
    },
  };
}
