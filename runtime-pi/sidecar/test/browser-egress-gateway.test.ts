// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";

import { createBrowserEgressGateway } from "../browser-egress-gateway.ts";
import { parseUpstreamProxyUrl } from "../upstream-proxy-connect.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return address.port;
}

async function connectRequest(
  port: number,
  target: string,
  token = TOKEN,
): Promise<{ socket: Socket; header: string; remainder: Buffer }> {
  const socket = netConnect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
  );
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const end = combined.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({
        socket,
        header: combined.subarray(0, end).toString("latin1"),
        remainder: combined.subarray(end + 4),
      });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("browser egress gateway", () => {
  it("parses only strict HTTP proxy origins", () => {
    expect(parseUpstreamProxyUrl("http://user:pass@proxy.example:3128")).toEqual({
      host: "proxy.example",
      port: 3128,
      authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    });
    for (const proxy of [
      "https://proxy.example",
      "http://proxy.example/path",
      "http://proxy.example?token=x",
      "http://:password@proxy.example",
    ]) {
      expect(() => parseUpstreamProxyUrl(proxy), proxy).toThrow();
    }
  });

  it("authenticates, enforces the exact origin, and blind-relays bytes", async () => {
    const echo = createNetServer((socket) => socket.pipe(socket));
    const targetPort = await listen(echo);
    const events: string[] = [];
    const gateway = createBrowserEgressGateway({
      authToken: TOKEN,
      allowedOrigins: [`https://browser.example:${targetPort}`],
      isBlockedHostFn: () => false,
      resolveHostFn: async () => ["127.0.0.1"],
      onEvent: (event) => events.push(event.kind),
    });
    await gateway.ready;
    cleanup.push(() => gateway.close());

    const tunnel = await connectRequest(gateway.address().port, `browser.example:${targetPort}`);
    expect(tunnel.header).toContain("200 Connection Established");
    const payload = Buffer.from([0, 1, 2, 255, 13, 10]);
    tunnel.socket.write(payload);
    const echoed = await new Promise<Buffer>((resolve) => tunnel.socket.once("data", resolve));
    expect(echoed).toEqual(payload);
    expect(events).toContain("gateway-allowed");
    tunnel.socket.destroy();
  });

  it("opens no upstream socket for a wrong token or undeclared origin", async () => {
    let resolutions = 0;
    const gateway = createBrowserEgressGateway({
      authToken: TOKEN,
      allowedOrigins: ["https://allowed.example"],
      isBlockedHostFn: () => false,
      resolveHostFn: async () => {
        resolutions += 1;
        return ["127.0.0.1"];
      },
    });
    await gateway.ready;
    cleanup.push(() => gateway.close());

    const unauthenticated = await connectRequest(
      gateway.address().port,
      "allowed.example:443",
      "wrong-wrong-wrong-wrong-wrong-wrong",
    );
    expect(unauthenticated.header).toContain("407 Proxy Authentication Required");
    unauthenticated.socket.destroy();

    const undeclared = await connectRequest(gateway.address().port, "other.example:443");
    expect(undeclared.header).toContain("403 Forbidden");
    undeclared.socket.destroy();
    expect(resolutions).toBe(0);
  });

  it("bounds concurrent tunnels and tears idle sockets down", async () => {
    const echo = createNetServer((socket) => socket.pipe(socket));
    const targetPort = await listen(echo);
    const gateway = createBrowserEgressGateway({
      authToken: TOKEN,
      allowedOrigins: [`https://browser.example:${targetPort}`],
      maxConcurrentTunnels: 1,
      idleTunnelMs: 100,
      isBlockedHostFn: () => false,
      resolveHostFn: async () => ["127.0.0.1"],
    });
    await gateway.ready;
    cleanup.push(() => gateway.close());

    const first = await connectRequest(gateway.address().port, `browser.example:${targetPort}`);
    expect(first.header).toContain("200 Connection Established");
    const firstClosed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
    const second = await connectRequest(gateway.address().port, `browser.example:${targetPort}`);
    expect(second.header).toContain("429 Too Many Requests");
    second.socket.destroy();

    await firstClosed;
  });

  it("never falls back to direct egress when the selected proxy rejects CONNECT", async () => {
    let proxyRequest = "";
    const proxy = createNetServer((socket) => {
      socket.once("data", (chunk) => {
        proxyRequest = chunk.toString("latin1");
        socket.end("HTTP/1.1 502 Proxy Refused\r\n\r\n");
      });
    });
    const proxyPort = await listen(proxy);
    let pinnedResolutions = 0;
    const events: string[] = [];
    const gateway = createBrowserEgressGateway({
      authToken: TOKEN,
      allowedOrigins: ["https://allowed.example"],
      upstreamProxyUrl: `http://127.0.0.1:${proxyPort}`,
      isBlockedHostFn: () => false,
      resolveHostFn: async () => {
        pinnedResolutions += 1;
        return ["127.0.0.1"];
      },
      onEvent: (event) => events.push(event.kind),
    });
    await gateway.ready;
    cleanup.push(() => gateway.close());

    const response = await connectRequest(gateway.address().port, "allowed.example:443");
    expect(response.header).toContain("502 Bad Gateway");
    response.socket.destroy();
    // DNS is resolved once to pin the CONNECT target. The gateway still opens
    // no direct socket: the rejecting proxy is the only dialled egress hop.
    expect(pinnedResolutions).toBe(1);
    expect(proxyRequest).toContain("CONNECT 127.0.0.1:443 HTTP/1.1");
    expect(proxyRequest).not.toContain("CONNECT allowed.example:443");
    expect(events).toContain("gateway-proxy-failed");
  });

  it("rejects private destinations even if they appear in the origin list", async () => {
    const gateway = createBrowserEgressGateway({
      authToken: TOKEN,
      allowedOrigins: ["https://127.0.0.1"],
    });
    await gateway.ready;
    cleanup.push(() => gateway.close());
    const response = await connectRequest(gateway.address().port, "127.0.0.1:443");
    expect(response.header).toContain("403 Forbidden");
    response.socket.destroy();
  });
});
