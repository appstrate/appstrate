// SPDX-License-Identifier: Apache-2.0

/**
 * Per-integration PLAIN CONNECT egress listener (issue #543).
 *
 * A local-source runner sits on the per-run network (`internal: true` in
 * docker mode) with no direct egress. When the integration injects a
 * credential header it gets a TLS-terminating MITM listener
 * ({@link createIntegrationMitmListener}) which doubles as its egress route.
 * When it injects NOTHING (a `delivery.env` auth — the server authenticates
 * itself, e.g. a form/session login) it only needs a way OUT, not a proxy
 * that opens its TLS. This listener is that way out:
 *
 *   - terminates the `CONNECT host:port` preamble,
 *   - applies the SSRF floor at CONNECT (the ONLY hard boundary — internal /
 *     cloud-metadata targets are refused before any tunnel opens),
 *   - blind-relays raw TCP both directions (NO TLS termination, NO per-SNI
 *     cert mint, NO header injection).
 *
 * It deliberately mirrors the MITM listener's {@link MitmListenerHandle}
 * surface (`ready` / `address` / `proxyUrl` / `close`) so `integrations-boot`
 * collects and tears down both listener kinds uniformly. CONNECT-only, exactly
 * like the MITM listener (which 405s plain HTTP) — env-delivery runners
 * previously routed through MITM, so HTTPS-only egress is unchanged behaviour.
 *
 * Egress is intentionally open to any external host today; turning
 * `authorizedUris` into a hard per-integration allowlist is a separate,
 * deliberate security decision (#543). The param is accepted now so that
 * enforcement, if adopted, lands here at CONNECT.
 */

import { createServer as netCreateServer } from "node:net";
import type { Socket } from "node:net";

import { isBlockedHost } from "./helpers.ts";
import { parseConnectTarget, netConnectWithTimeout, relaySockets } from "./connect-tunnel.ts";
import type { MitmListenerHandle } from "./integration-mitm-listener.ts";

export interface EgressListenerEvent {
  kind: "tunnel-opened" | "tunnel-refused" | "tunnel-error";
  /** `host:port` target of the CONNECT (never carries a path / query). */
  target: string;
  /** Populated for `tunnel-refused` (SSRF / allowlist) and `tunnel-error`. */
  reason?: string;
}

export interface CreateEgressListenerOptions {
  /** Bind host — adapter-chosen (0.0.0.0 bridged / 127.0.0.1 shared NS). */
  host?: string;
  /** Telemetry sink (host:port + outcome only — never request contents). */
  onEvent?: (event: EgressListenerEvent) => void;
  /** Injectable SSRF predicate (tests pass a permissive stub). */
  isBlockedHostFn?: typeof isBlockedHost;
  /**
   * Optional hard egress allowlist (#543 follow-up). When provided, a CONNECT
   * whose host matches NONE of the patterns is refused. `undefined` (default)
   * leaves egress SSRF-floored-open — today's behaviour. The matcher is
   * supplied by the caller to avoid coupling this transport file to the
   * URI-pattern grammar.
   */
  authorizedHostMatcher?: (host: string) => boolean;
}

/**
 * Create a per-integration plain CONNECT egress listener on an ephemeral port.
 * Returns a {@link MitmListenerHandle}-shaped handle for uniform lifecycle
 * management alongside MITM listeners.
 */
export function createIntegrationEgressListener(
  options: CreateEgressListenerOptions = {},
): MitmListenerHandle {
  const host = options.host ?? "127.0.0.1";
  const isBlockedHostFn = options.isBlockedHostFn ?? isBlockedHost;
  const emit = options.onEvent ?? (() => {});
  const matcher = options.authorizedHostMatcher;

  const server = netCreateServer();

  server.on("connection", (clientSocket: Socket) => {
    // The kernel hands us a raw TCP socket; we must read the CONNECT preamble
    // ourselves (net.Server has no `connect` event — that's http.Server). The
    // request line can be split across TCP segments, so accumulate until the
    // first CRLF instead of assuming it arrives in one chunk; cap the buffer so
    // a peer that never sends a CRLF can't grow it unbounded. Headers after the
    // request line are ignored (we tunnel, not inspect); a well-behaved CONNECT
    // client waits for the 200 before sending tunnel bytes, so none are lost.
    const MAX_PREAMBLE_BYTES = 8_192;
    let preamble = "";
    const onData = (chunk: Buffer) => {
      preamble += chunk.toString("latin1");
      const lineEnd = preamble.indexOf("\r\n");
      if (lineEnd === -1) {
        if (preamble.length > MAX_PREAMBLE_BYTES) {
          clientSocket.off("data", onData);
          clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          clientSocket.destroy();
        }
        return; // request line not complete yet — await more segments
      }
      clientSocket.off("data", onData);
      const firstLine = preamble.slice(0, lineEnd);
      const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
      if (!match) {
        clientSocket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const target = match[1] ?? "";
      const parsed = parseConnectTarget(target);
      if (!parsed) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const { host: targetHost, port } = parsed;

      // SSRF floor — the hard boundary. Refuse internal / cloud-metadata
      // targets before opening any tunnel.
      if (isBlockedHostFn(targetHost.toLowerCase())) {
        emit({ kind: "tunnel-refused", target, reason: "ssrf" });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      // Optional hard egress allowlist (#543 follow-up; no-op by default).
      if (matcher && !matcher(targetHost.toLowerCase())) {
        emit({ kind: "tunnel-refused", target, reason: "not-authorized" });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const upstream = netConnectWithTimeout(port, targetHost, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        emit({ kind: "tunnel-opened", target });
        relaySockets(clientSocket, upstream);
      });
      upstream.on("error", (err: Error) => {
        emit({ kind: "tunnel-error", target, reason: err.message });
        clientSocket.destroy();
      });
      clientSocket.on("error", () => upstream.destroy());
    };
    clientSocket.on("data", onData);
    clientSocket.on("error", () => clientSocket.destroy());
  });

  let readyResolve!: () => void;
  const ready = new Promise<void>((res) => {
    readyResolve = res;
  });
  // Ephemeral port (0 → kernel-assigned, read back via address() after ready).
  server.listen(0, host, () => readyResolve());

  const addr = () => {
    const a = server.address();
    return a && typeof a === "object" ? { host: a.address, port: a.port } : { host, port: 0 };
  };

  return {
    ready,
    address: addr,
    proxyUrl() {
      const a = addr();
      return `http://${a.host}:${a.port}`;
    },
    close() {
      return new Promise<void>((res) => server.close(() => res()));
    },
  };
}
