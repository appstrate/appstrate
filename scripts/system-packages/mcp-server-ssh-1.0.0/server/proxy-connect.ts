// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSSH `ProxyCommand` that reaches the target through an HTTP CONNECT
 * proxy — the sidecar's per-run egress listener, handed to the runner as
 * `HTTPS_PROXY`.
 *
 * OpenSSH has no CONNECT support of its own, and the busybox `nc` in the
 * runner image has no `-X connect`. So `index.ts` runs ssh/sftp with
 * `-o ProxyCommand="bun <this file> %h %p"`: ssh expands `%h %p`, this
 * process opens the tunnel and splices its own stdin/stdout onto the socket.
 * The SSH transcript rides the tunnel opaque; the proxy sees bytes.
 *
 * Reached by OpenSSH as a subprocess, never by an import — which is why
 * `knip.config.ts` lists it as an entry.
 */

import { connect, type Socket } from "node:net";

export interface ConnectVerdict {
  ok: boolean;
  /** The proxy's status line, verbatim — a refusal must stay legible. */
  statusLine: string;
  /** Bytes that arrived after the header and belong to the tunnel. */
  rest: Buffer;
}

/**
 * Parse the start of a CONNECT response. Returns null until the blank line
 * terminating the header has arrived.
 */
export function parseConnectResponse(banner: Buffer): ConnectVerdict | null {
  const end = banner.indexOf("\r\n\r\n");
  if (end === -1) return null;
  const head = banner.subarray(0, end).toString("latin1");
  const statusLine = head.slice(
    0,
    head.indexOf("\r\n") === -1 ? head.length : head.indexOf("\r\n"),
  );
  return {
    ok: /^HTTP\/1\.[01] 2\d\d/.test(statusLine),
    statusLine,
    rest: banner.subarray(end + 4),
  };
}

/** Resolve the proxy URL from the env the sidecar's adapter sets. */
export function proxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? null;
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

const MAX_HEADER_BYTES = 16 * 1024;

function dial(
  proxyUrl: string,
  host: string,
  port: number,
): Promise<{ socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      reject(new Error(`proxy is not a URL: ${proxyUrl}`));
      return;
    }
    const proxyPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const socket = connect(proxyPort, parsed.hostname, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    let banner = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      banner = Buffer.concat([banner, chunk]);
      const verdict = parseConnectResponse(banner);
      if (!verdict) {
        if (banner.length > MAX_HEADER_BYTES) {
          socket.destroy();
          reject(new Error("CONNECT response header exceeded 16 KiB"));
        }
        return;
      }
      socket.removeListener("data", onData);
      if (!verdict.ok) {
        socket.destroy();
        // The sidecar answers a blocked target here. Surfacing its own
        // status line is what makes an SSRF refusal read as a refusal
        // instead of a dead host.
        reject(new Error(`CONNECT refused by proxy: ${verdict.statusLine}`));
        return;
      }
      resolve({ socket, rest: verdict.rest });
    };
    socket.on("data", onData);
    socket.once("error", (err) => reject(new Error(`CONNECT dial failed: ${err.message}`)));
  });
}

async function main(argv: string[]): Promise<void> {
  const [host, portArg] = argv;
  const port = Number(portArg ?? "22");
  if (!host || !Number.isInteger(port) || port <= 0) {
    process.stderr.write("usage: proxy-connect.ts <host> <port>\n");
    process.exit(2);
  }
  const proxyUrl = proxyUrlFromEnv();
  if (!proxyUrl) {
    process.stderr.write("proxy-connect: HTTPS_PROXY is not set\n");
    process.exit(2);
  }

  let tunnel: { socket: Socket; rest: Buffer };
  try {
    tunnel = await dial(proxyUrl, host, port);
  } catch (err) {
    process.stderr.write(`proxy-connect: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const { socket, rest } = tunnel;
  if (rest.length > 0) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.once("close", () => process.exit(0));
  socket.once("error", () => process.exit(1));
  process.stdin.once("end", () => socket.end());
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  void main(process.argv.slice(2));
}
