// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/install.ts` parsing helpers.
 *
 * We only exercise the non-interactive branches (`raw !== undefined`).
 * The interactive clack `select`/`askText` paths require a real TTY
 * and are exercised by the e2e install smoke test in CI.
 *
 * Coverage targets the three safety-critical validations:
 *   - `resolveTier` rejects anything other than 0/1/2/3 (a stray `--tier
 *     4` must abort BEFORE `generateEnvForTier` asserts non-exhaustively).
 *   - `resolveDir` rejects newlines + NUL bytes so no downstream shell
 *     script / backup tool gets confused (see the threat model comment
 *     in install.ts).
 *   - `resolveDir` normalizes to an absolute path so the spawn layer
 *     in tier0/tier123 gets a stable cwd.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import {
  resolveTier,
  resolveDir,
  parsePort,
  resolveAppstratePort,
  resolveMinioConsolePort,
} from "../src/commands/install.ts";

describe("resolveTier", () => {
  it("accepts '0', '1', '2', '3' as literal strings", async () => {
    expect(await resolveTier("0")).toBe(0);
    expect(await resolveTier("1")).toBe(1);
    expect(await resolveTier("2")).toBe(2);
    expect(await resolveTier("3")).toBe(3);
  });

  it("rejects out-of-range values", async () => {
    await expect(resolveTier("4")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("-1")).rejects.toThrow(/Invalid --tier/);
  });

  it("rejects non-numeric values", async () => {
    await expect(resolveTier("standard")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("1.5")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("NaN")).rejects.toThrow(/Invalid --tier/);
  });
});

describe("resolveDir", () => {
  it("resolves a relative path to an absolute one", async () => {
    const out = await resolveDir("./my-install");
    expect(out).toBe(resolve("./my-install"));
    expect(out.startsWith("/")).toBe(true);
  });

  it("leaves an already-absolute path untouched except for normalization", async () => {
    const out = await resolveDir("/tmp/foo/../foo");
    expect(out).toBe("/tmp/foo");
  });

  it("rejects paths containing a newline", async () => {
    await expect(resolveDir("/tmp/bad\npath")).rejects.toThrow(/newlines or NUL/);
    await expect(resolveDir("/tmp/bad\rpath")).rejects.toThrow(/newlines or NUL/);
  });

  it("rejects paths containing a NUL byte", async () => {
    await expect(resolveDir("/tmp/bad\0path")).rejects.toThrow(/newlines or NUL/);
  });
});

describe("parsePort", () => {
  it("returns the default when neither flag nor env var is set", () => {
    expect(parsePort(undefined, undefined, 3000, "--port")).toBe(3000);
  });

  it("prefers the flag value over the env value", () => {
    expect(parsePort("4000", "5000", 3000, "--port")).toBe(4000);
  });

  it("falls back to the env value when the flag is absent", () => {
    expect(parsePort(undefined, "5000", 3000, "--port")).toBe(5000);
  });

  it("treats an empty string like undefined (default)", () => {
    // Commander may hand us an empty string on `--port ""`; we'd rather
    // use the default than fail with a confusing "expected integer in
    // 1..65535" message.
    expect(parsePort("", "", 3000, "--port")).toBe(3000);
  });

  it("rejects non-integer values", () => {
    expect(() => parsePort("abc", undefined, 3000, "--port")).toThrow(/Invalid --port/);
    expect(() => parsePort("3000.5", undefined, 3000, "--port")).toThrow(/Invalid --port/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parsePort("0", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
    expect(() => parsePort("-5", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
    expect(() => parsePort("70000", undefined, 3000, "--port")).toThrow(/1\.\.65535/);
  });
});

describe("resolveAppstratePort (non-interactive preflight)", () => {
  const servers: Server[] = [];
  const originalEnvPort = process.env.APPSTRATE_PORT;
  const originalEnvMinio = process.env.APPSTRATE_MINIO_CONSOLE_PORT;

  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
    if (originalEnvPort === undefined) delete process.env.APPSTRATE_PORT;
    else process.env.APPSTRATE_PORT = originalEnvPort;
    if (originalEnvMinio === undefined) delete process.env.APPSTRATE_MINIO_CONSOLE_PORT;
    else process.env.APPSTRATE_MINIO_CONSOLE_PORT = originalEnvMinio;
  });

  it("returns the requested port when it is free", async () => {
    const port = await pickEphemeralPort();
    const out = await resolveAppstratePort(String(port), /* nonInteractive */ true);
    expect(out).toBe(port);
  });

  it("throws a helpful error when the port is taken (non-interactive)", async () => {
    const port = await holdEphemeralPort(servers);
    await expect(resolveAppstratePort(String(port), true)).rejects.toThrow(
      /Port \d+ is already in use.*APPSTRATE_PORT|--port/,
    );
  });

  it("honors APPSTRATE_PORT when --port is absent", async () => {
    const port = await pickEphemeralPort();
    process.env.APPSTRATE_PORT = String(port);
    const out = await resolveAppstratePort(undefined, true);
    expect(out).toBe(port);
  });
});

describe("resolveMinioConsolePort (non-interactive preflight)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(() => r(undefined)));
  });

  it("surfaces the MinIO label in the error message", async () => {
    const port = await holdEphemeralPort(servers);
    await expect(resolveMinioConsolePort(String(port), true)).rejects.toThrow(
      /MinIO console.*--minio-console-port|APPSTRATE_MINIO_CONSOLE_PORT/,
    );
  });
});

async function pickEphemeralPort(): Promise<number> {
  const srv = createServer();
  srv.unref();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function holdEphemeralPort(holders: Server[]): Promise<number> {
  const srv = createServer();
  srv.unref();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  holders.push(srv);
  return port;
}
