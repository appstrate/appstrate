// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the platform-side remote-runner env (remote-env.ts):
 * the SEC-2 transport-security gate. The platform↔daemon wire carries the
 * bearer token plus per-run credentials, so plaintext http:// to a
 * NON-loopback daemon is REFUSED by default; the explicit opt-out
 * FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1 downgrades the refusal to a loud
 * warning. Loopback http:// (all of 127.0.0.0/8, localhost, [::1], the
 * IPv4-mapped loopback) and https:// always pass.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  assertRunnerTransportSecurity,
  getRemoteEnv,
  RunnerTransportSecurityError,
  _resetRemoteEnvCacheForTesting,
} from "../../remote-env.ts";

const KEYS = [
  "FIRECRACKER_RUNNER_URL",
  "FIRECRACKER_RUNNER_TOKEN",
  "FIRECRACKER_RUNNER_ALLOW_PLAINTEXT",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetRemoteEnvCacheForTesting();
});

describe("assertRunnerTransportSecurity", () => {
  it("passes an https non-loopback URL silently", () => {
    const warnings: string[] = [];
    expect(() =>
      assertRunnerTransportSecurity("https://runner.internal:3100", false, (m) => warnings.push(m)),
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("passes loopback http:// silently (same-host dev)", () => {
    const warnings: string[] = [];
    for (const url of [
      "http://127.0.0.1:3100",
      "http://localhost:3100",
      "http://[::1]:3100",
      // 127.0.0.0/8 — the whole block is loopback, not just .0.0.1.
      "http://127.0.0.2:3100",
      "http://127.255.255.254:3100",
      // IPv4-mapped IPv6 loopback (URL normalizes it to [::ffff:7f00:1]).
      "http://[::ffff:127.0.0.1]:3100",
    ]) {
      expect(() =>
        assertRunnerTransportSecurity(url, false, (m) => warnings.push(m)),
      ).not.toThrow();
    }
    expect(warnings).toEqual([]);
  });

  it("refuses plaintext non-loopback by default, naming the opt-out env var and the same-host caveat", () => {
    let error: unknown;
    try {
      assertRunnerTransportSecurity("http://10.0.0.5:3100", false);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RunnerTransportSecurityError);
    const message = (error as Error).message;
    expect(message).toContain("FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1");
    expect(message).toContain("share a host");
    // The error must log under its own name, not the generic "Error".
    expect((error as Error).name).toBe("RunnerTransportSecurityError");
  });

  it("does NOT treat a near-loopback host as loopback (128.0.0.1 refused)", () => {
    expect(() => assertRunnerTransportSecurity("http://128.0.0.1:3100", false)).toThrow(
      RunnerTransportSecurityError,
    );
  });

  it("allows plaintext non-loopback with the explicit opt-out, warning exactly once", () => {
    const warnings: string[] = [];
    expect(() =>
      assertRunnerTransportSecurity("http://10.0.0.5:3100", true, (m) => warnings.push(m)),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1");
    expect(warnings[0]).toContain("TLS");
  });
});

describe("getRemoteEnv transport gate (end-to-end)", () => {
  function setEnv(url: string, allowPlaintext?: string): void {
    process.env.FIRECRACKER_RUNNER_URL = url;
    process.env.FIRECRACKER_RUNNER_TOKEN = "0123456789abcdef";
    if (allowPlaintext === undefined) delete process.env.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT;
    else process.env.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT = allowPlaintext;
    _resetRemoteEnvCacheForTesting();
  }

  it("refuses a plaintext non-loopback URL by default (no env var set)", () => {
    setEnv("http://10.0.0.5:3100");
    expect(() => getRemoteEnv()).toThrow(/FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1/);
  });

  it("refuses a plaintext non-loopback URL when FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=0 (explicit refuse)", () => {
    setEnv("http://10.0.0.5:3100", "0");
    expect(() => getRemoteEnv()).toThrow(/FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1/);
  });

  it("parses a plaintext non-loopback URL when FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1 (explicit opt-out)", () => {
    setEnv("http://10.0.0.5:3100", "1");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("http://10.0.0.5:3100");
    expect(env.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT).toBe(true);
  });

  it("parses a loopback plaintext URL with no env var set", () => {
    setEnv("http://127.0.0.1:3100");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("http://127.0.0.1:3100");
    expect(env.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT).toBe(false);
  });

  it("parses a 127/8 (non-.1) loopback plaintext URL with no env var set", () => {
    setEnv("http://127.0.0.2:3100");
    expect(() => getRemoteEnv()).not.toThrow();
  });

  it("accepts an https URL without the opt-out", () => {
    setEnv("https://runner.internal:3100");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("https://runner.internal:3100");
    expect(env.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT).toBe(false);
  });

  it("rejects an unrecognized FIRECRACKER_RUNNER_ALLOW_PLAINTEXT value (no accidental opt-out)", () => {
    setEnv("https://runner.internal:3100", "yes");
    expect(() => getRemoteEnv()).toThrow(/'1'\/'true' .* '0'\/'false'/);
  });

  it("treats an empty FIRECRACKER_RUNNER_ALLOW_PLAINTEXT as unset (default refusal stands)", () => {
    setEnv("http://10.0.0.5:3100", "");
    expect(() => getRemoteEnv()).toThrow(/FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1/);
  });
});
