// SPDX-License-Identifier: Apache-2.0

/**
 * The sidecar entry point exits when its forward proxy cannot bind. The
 * platform's fail-fast (#1561) watches for a sidecar that EXITS; one left alive
 * without its proxy would let the run go on with a dead `HTTP_PROXY`.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const SERVER_ENTRY = join(import.meta.dir, "..", "server.ts");

function freePort(): number {
  const probe = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

describe("sidecar entry: forward proxy bind failure", () => {
  it("exits non-zero and names the forward proxy when its port is taken", async () => {
    const holder = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    try {
      const proc = Bun.spawn(["bun", "run", SERVER_ENTRY], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PORT: String(freePort()),
          FORWARD_PROXY_PORT: String(holder.port),
          PLATFORM_API_URL: "http://127.0.0.1:9",
          RUN_TOKEN: "run-token",
          SIDECAR_AUTH_TOKEN: "sidecar-token",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      clearTimeout(timer);

      expect(code).toBe(1);
      // Discriminates this exit from any other boot failure (env, main port).
      const line = stderr
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { msg: string; port?: number; error?: string })
        .find((l) => l.msg === "Forward proxy could not bind, exiting");
      expect(line?.port).toBe(holder.port);
      expect(line?.error).toContain("in use");
    } finally {
      holder.stop(true);
    }
  }, 20_000);
});
