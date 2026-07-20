// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";

import { CdpClient } from "../src/cdp.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("CDP client bounds", () => {
  it("rejects a command when Chrome leaves it unanswered", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        return bunServer.upgrade(request, { data: undefined })
          ? undefined
          : new Response("Upgrade required", { status: 426 });
      },
      websocket: {
        message(_socket, _message) {
          // Deliberately leave the JSON-RPC command unanswered.
        },
      },
    });
    const endpoint = server.url.href.replace(/^http:/, "ws:");
    const client = await CdpClient.connect(endpoint);
    try {
      await expect(client.send("Runtime.evaluate", {}, 25)).rejects.toThrow(
        "CDP command timed out: Runtime.evaluate",
      );
    } finally {
      client.close();
    }
  });

  it("rejects invalid command timeouts before sending", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        return bunServer.upgrade(request, { data: undefined })
          ? undefined
          : new Response("Upgrade required", { status: 426 });
      },
      websocket: { message(_socket, _message) {} },
    });
    const endpoint = server.url.href.replace(/^http:/, "ws:");
    const client = await CdpClient.connect(endpoint);
    try {
      await expect(client.send("Runtime.evaluate", {}, 0)).rejects.toThrow(
        "CDP command timeout is outside the allowed range",
      );
    } finally {
      client.close();
    }
  });
});
