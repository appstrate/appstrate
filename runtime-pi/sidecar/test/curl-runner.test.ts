// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for the curl-CLI `fetch` wrapper (issue #403).
 *
 * Two layers:
 *   - Unit (fake spawn): argv construction + response parsing, no network.
 *   - Integration (real `curl` against a local http server): end-to-end
 *     behaviour. Skipped automatically when `curl` is absent.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import {
  curlFetch,
  resolveCurlRunnerConfig,
  CurlRunnerError,
  type CurlSpawnFn,
  type CurlRunnerConfig,
} from "../curl-runner.ts";

// ─────────────────────────────────────────────
// Fake spawn — captures argv, replays a canned response
// ─────────────────────────────────────────────

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface FakeSpawn {
  spawn: CurlSpawnFn;
  calls: Array<{ cmd: string[]; stdin: unknown }>;
}

function fakeSpawn(
  stdout: string | Uint8Array,
  opts: { code?: number; stderr?: string } = {},
): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const enc = new TextEncoder();
  const spawn: CurlSpawnFn = (cmd, o) => {
    calls.push({ cmd, stdin: o.stdin });
    return {
      exited: Promise.resolve(opts.code ?? 0),
      stdout: streamOf(typeof stdout === "string" ? enc.encode(stdout) : stdout),
      stderr: streamOf(enc.encode(opts.stderr ?? "")),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

function cfgWith(spawn: CurlSpawnFn, overrides: Partial<CurlRunnerConfig> = {}): CurlRunnerConfig {
  return resolveCurlRunnerConfig({}, { spawn, ...overrides });
}

describe("curlFetch — argv construction (fake spawn)", () => {
  it("builds a plain GET with -q first, manual redirect, --compressed", async () => {
    const fake = fakeSpawn("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhi");
    await curlFetch("https://api.exotic.com/x", { method: "GET" }, cfgWith(fake.spawn));
    const argv = fake.calls[0]!.cmd;
    expect(argv[0]).toBe("curl"); // bin
    expect(argv[1]).toBe("-q"); // curlrc ignored, first
    expect(argv).toContain("--compressed");
    expect(argv).not.toContain("-L"); // never follow redirects
    expect(argv).toContain("-X");
    expect(argv[argv.indexOf("-X") + 1]).toBe("GET");
    expect(argv).toContain("--"); // url terminator
    expect(argv[argv.length - 1]).toBe("https://api.exotic.com/x");
  });

  it("uses the impersonate binary and --impersonate flag", async () => {
    const fake = fakeSpawn("HTTP/2 200\r\n\r\nok");
    await curlFetch(
      "https://api.exotic.com/x",
      { method: "GET", impersonate: "chrome" },
      cfgWith(fake.spawn, { impersonateBin: "curl-impersonate" }),
    );
    const argv = fake.calls[0]!.cmd;
    expect(argv[0]).toBe("curl-impersonate");
    expect(argv).toContain("--impersonate");
    expect(argv[argv.indexOf("--impersonate") + 1]).toBe("chrome");
  });

  it("forwards headers and suppresses Expect: 100-continue by default", async () => {
    const fake = fakeSpawn("HTTP/1.1 200 OK\r\n\r\n");
    await curlFetch(
      "https://x/y",
      { headers: { Authorization: "Bearer t", "X-Foo": "bar" } },
      cfgWith(fake.spawn),
    );
    const argv = fake.calls[0]!.cmd;
    // Header names normalise to lowercase (HTTP/2 requires it; matches the
    // existing Bun-fetch path).
    expect(argv).toContain("authorization: Bearer t");
    expect(argv).toContain("x-foo: bar");
    expect(argv).toContain("Expect:");
  });

  it("passes the body via stdin and --data-binary @-", async () => {
    const fake = fakeSpawn("HTTP/1.1 201 Created\r\n\r\n");
    await curlFetch("https://x/y", { method: "POST", body: "payload" }, cfgWith(fake.spawn));
    const argv = fake.calls[0]!.cmd;
    expect(argv).toContain("--data-binary");
    expect(argv[argv.indexOf("--data-binary") + 1]).toBe("@-");
    const stdin = fake.calls[0]!.stdin as Uint8Array;
    expect(new TextDecoder().decode(stdin)).toBe("payload");
  });

  it("parses status, statusText, headers and body", async () => {
    const fake = fakeSpawn(
      'HTTP/1.1 418 I\'m a teapot\r\nX-A: 1\r\nX-A: 2\r\nContent-Type: application/json\r\n\r\n{"ok":true}',
    );
    const res = await curlFetch("https://x/y", {}, cfgWith(fake.spawn));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("I'm a teapot");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("skips a leading 1xx informational block", async () => {
    const fake = fakeSpawn("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\nbody");
    const res = await curlFetch("https://x/y", {}, cfgWith(fake.spawn));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  it("returns a 3xx verbatim (manual redirect — no follow)", async () => {
    const fake = fakeSpawn("HTTP/1.1 302 Found\r\nLocation: https://elsewhere/\r\n\r\n");
    const res = await curlFetch("https://x/y", {}, cfgWith(fake.spawn));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere/");
    expect(fake.calls).toHaveLength(1);
  });

  it("throws CurlRunnerError on non-zero exit", async () => {
    const fake = fakeSpawn("", { code: 28, stderr: "Operation timed out" });
    await expect(curlFetch("https://x/y", {}, cfgWith(fake.spawn))).rejects.toBeInstanceOf(
      CurlRunnerError,
    );
  });

  it("throws when the body exceeds the cap", async () => {
    const big = "HTTP/1.1 200 OK\r\n\r\n" + "x".repeat(50);
    const fake = fakeSpawn(big);
    await expect(
      curlFetch("https://x/y", {}, cfgWith(fake.spawn, { maxBytes: 10 })),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("aborts before spawn when the signal is already aborted", async () => {
    const fake = fakeSpawn("HTTP/1.1 200 OK\r\n\r\n");
    await expect(
      curlFetch("https://x/y", { signal: AbortSignal.abort() }, cfgWith(fake.spawn)),
    ).rejects.toBeInstanceOf(CurlRunnerError);
    expect(fake.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Integration — real curl against a local server
// ─────────────────────────────────────────────

async function curlAvailable(): Promise<boolean> {
  try {
    const proc = (globalThis as unknown as { Bun?: { spawn: CurlSpawnFn } }).Bun?.spawn(
      ["curl", "--version"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (!proc) return false;
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const HAS_CURL = await curlAvailable();
const runIfCurl: typeof it = HAS_CURL ? it : (it.skip as unknown as typeof it);

const servers: HttpServer[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("curlFetch — integration (real curl)", () => {
  runIfCurl("GETs a body and status from a real server", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello-curl");
    });
    const res = await curlFetch(`${base}/`, {}, resolveCurlRunnerConfig());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-curl");
  });

  runIfCurl("POSTs a body the server echoes back", async () => {
    const base = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Method": req.method ?? "" });
        res.end(`echo:${body}`);
      });
    });
    const res = await curlFetch(
      `${base}/`,
      { method: "POST", body: "the-payload" },
      resolveCurlRunnerConfig(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-method")).toBe("POST");
    expect(await res.text()).toBe("echo:the-payload");
  });

  runIfCurl("forwards a custom header upstream", async () => {
    const base = await startServer((req, res) => {
      res.writeHead(200);
      res.end(req.headers["x-token"] ?? "none");
    });
    const res = await curlFetch(
      `${base}/`,
      { headers: { "X-Token": "secret-123" } },
      resolveCurlRunnerConfig(),
    );
    expect(await res.text()).toBe("secret-123");
  });

  runIfCurl("decompresses a gzip body (--compressed)", async () => {
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "application/json" });
      res.end(gzipSync(Buffer.from(payload)));
    });
    const res = await curlFetch(`${base}/`, {}, resolveCurlRunnerConfig());
    expect(await res.text()).toBe(payload);
  });

  runIfCurl("returns a 3xx without following it", async () => {
    const base = await startServer((req, res) => {
      if (req.url === "/from") {
        res.writeHead(302, { Location: "/to" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("followed");
      }
    });
    const res = await curlFetch(`${base}/from`, {}, resolveCurlRunnerConfig());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/to");
  });

  runIfCurl("passes a 404 through unchanged", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const res = await curlFetch(`${base}/`, {}, resolveCurlRunnerConfig());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
  });
});
