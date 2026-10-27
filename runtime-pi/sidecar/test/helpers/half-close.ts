// SPDX-License-Identifier: Apache-2.0

/** Half-close fixtures shared by the tunnel tests: a FIN must travel as a FIN, not a teardown. */

import { createServer as netCreateServer, connect as netConnect } from "node:net";
import type { Server as NetServer } from "node:net";

/**
 * An upstream that answers only after the client's FIN: `late:<bytes received>`, then its own
 * FIN. `closed` settles when its socket closes.
 */
export function startLateReplyServer(
  track: (server: NetServer) => void,
): Promise<{ port: number; closed: Promise<void> }> {
  let markClosed!: () => void;
  const closed = new Promise<void>((res) => (markClosed = res));
  const server = netCreateServer({ allowHalfOpen: true }, (socket) => {
    let received = "";
    socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
    socket.on("end", () => setTimeout(() => socket.end(`late:${received}`), 50));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => markClosed());
  });
  track(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, closed });
    });
  });
}

/**
 * Write `preface` (a CONNECT head, whose answer is awaited, or nothing), then `payload` and a
 * FIN. Resolves with what came back after the head, and whether the connection then closed
 * (within 3 s).
 */
export function halfCloseClient(
  port: number,
  payload: string | Buffer,
  connectTarget?: string,
): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    let buf = "";
    let started = false;
    const socket = netConnect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => {
      if (connectTarget) socket.write(`CONNECT ${connectTarget} HTTP/1.1\r\nHost: x\r\n\r\n`);
      else start();
    });
    const start = () => {
      started = true;
      socket.end(payload);
    };
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      if (started || !buf.includes("\r\n\r\n")) return;
      buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
      start();
    });
    socket.on("error", () => {});
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ received: buf, closed });
    };
    socket.on("close", () => finish(true));
    const timer = setTimeout(() => finish(false), 3_000);
  });
}
