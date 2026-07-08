// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's listen-config resolution (runner/env.ts,
 * issue #868): FIRECRACKER_RUNNER_SOCKET (UDS) wins over host/port when
 * set — the co-located transport where the platform↔daemon wire never
 * touches the network — and the octal socket-mode string is validated
 * and parsed here, so daemon.ts chmods with a plain number.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  getRunnerEnv,
  resolveListenConfig,
  _resetRunnerEnvCacheForTesting,
} from "../../runner/env.ts";

const KEYS = [
  "FIRECRACKER_RUNNER_TOKEN",
  "FIRECRACKER_RUNNER_PORT",
  "FIRECRACKER_RUNNER_HOST",
  "FIRECRACKER_RUNNER_PLATFORM_URL",
  "FIRECRACKER_RUNNER_SOCKET",
  "FIRECRACKER_RUNNER_SOCKET_MODE",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetRunnerEnvCacheForTesting();
});

/** Minimal valid daemon env + per-test overrides; undefined = unset. */
function setEnv(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}): void {
  const base: Record<string, string | undefined> = {
    FIRECRACKER_RUNNER_TOKEN: "0123456789abcdef",
    FIRECRACKER_RUNNER_PLATFORM_URL: "http://10.0.0.5:3000",
    FIRECRACKER_RUNNER_PORT: undefined,
    FIRECRACKER_RUNNER_HOST: undefined,
    FIRECRACKER_RUNNER_SOCKET: undefined,
    FIRECRACKER_RUNNER_SOCKET_MODE: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetRunnerEnvCacheForTesting();
}

describe("resolveListenConfig", () => {
  it("resolves tcp host:port when no socket is set (defaults)", () => {
    setEnv();
    expect(resolveListenConfig(getRunnerEnv())).toEqual({
      kind: "tcp",
      host: "0.0.0.0",
      port: 3100,
    });
  });

  it("socket wins over explicitly set host/port", () => {
    setEnv({
      FIRECRACKER_RUNNER_SOCKET: "/run/appstrate-runner/runner.sock",
      FIRECRACKER_RUNNER_HOST: "10.0.0.9",
      FIRECRACKER_RUNNER_PORT: "3200",
    });
    expect(resolveListenConfig(getRunnerEnv())).toEqual({
      kind: "unix",
      socketPath: "/run/appstrate-runner/runner.sock",
      mode: 0o660,
    });
  });

  it("defaults the socket mode to 0660 (owner+group only)", () => {
    setEnv({ FIRECRACKER_RUNNER_SOCKET: "/tmp/runner.sock" });
    const listen = resolveListenConfig(getRunnerEnv());
    expect(listen.kind).toBe("unix");
    expect(listen.kind === "unix" && listen.mode).toBe(0o660);
  });

  it('accepts both "666" and "0666" mode spellings (parsed as octal)', () => {
    for (const raw of ["666", "0666"]) {
      setEnv({
        FIRECRACKER_RUNNER_SOCKET: "/tmp/runner.sock",
        FIRECRACKER_RUNNER_SOCKET_MODE: raw,
      });
      const listen = resolveListenConfig(getRunnerEnv());
      expect(listen.kind === "unix" && listen.mode).toBe(0o666);
    }
  });

  it('rejects a non-octal mode like "999"', () => {
    setEnv({
      FIRECRACKER_RUNNER_SOCKET: "/tmp/runner.sock",
      FIRECRACKER_RUNNER_SOCKET_MODE: "999",
    });
    expect(() => getRunnerEnv()).toThrow(/octal/);
  });

  it("rejects a relative socket path with an actionable message", () => {
    // A relative path would bind a different node per launch cwd
    // (systemd vs installer vs manual) — refuse instead of surprising.
    setEnv({ FIRECRACKER_RUNNER_SOCKET: "run/runner.sock" });
    expect(() => getRunnerEnv()).toThrow(/absolute path/);
  });
});
