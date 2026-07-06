// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the platform-side remote-runner env (remote-env.ts):
 * the SEC-2 transport-security gate. The platform↔daemon wire carries the
 * bearer token plus per-run credentials, so plaintext http:// to a
 * NON-loopback daemon warns loudly by default and becomes a hard refusal
 * when FIRECRACKER_RUNNER_TLS_REQUIRED=1. Loopback http:// and https://
 * always pass.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  assertRunnerTransportSecurity,
  getRemoteEnv,
  _resetRemoteEnvCacheForTesting,
} from "../../remote-env.ts";

const KEYS = [
  "FIRECRACKER_RUNNER_URL",
  "FIRECRACKER_RUNNER_TOKEN",
  "FIRECRACKER_RUNNER_TLS_REQUIRED",
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
    for (const url of ["http://127.0.0.1:3100", "http://localhost:3100"]) {
      expect(() =>
        assertRunnerTransportSecurity(url, false, (m) => warnings.push(m)),
      ).not.toThrow();
    }
    expect(warnings).toEqual([]);
  });

  it("warns exactly once (mentioning TLS) on plaintext non-loopback, without throwing", () => {
    const warnings: string[] = [];
    expect(() =>
      assertRunnerTransportSecurity("http://10.0.0.5:3100", false, (m) => warnings.push(m)),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TLS");
  });

  it("throws on plaintext non-loopback when tlsRequired, mentioning the env var", () => {
    expect(() => assertRunnerTransportSecurity("http://10.0.0.5:3100", true)).toThrow(
      /FIRECRACKER_RUNNER_TLS_REQUIRED/,
    );
  });
});

describe("getRemoteEnv transport gate (end-to-end)", () => {
  function setEnv(url: string, tlsRequired?: string): void {
    process.env.FIRECRACKER_RUNNER_URL = url;
    process.env.FIRECRACKER_RUNNER_TOKEN = "0123456789abcdef";
    if (tlsRequired === undefined) delete process.env.FIRECRACKER_RUNNER_TLS_REQUIRED;
    else process.env.FIRECRACKER_RUNNER_TLS_REQUIRED = tlsRequired;
    _resetRemoteEnvCacheForTesting();
  }

  it("refuses a plaintext non-loopback URL when FIRECRACKER_RUNNER_TLS_REQUIRED=1", () => {
    setEnv("http://10.0.0.5:3100", "1");
    expect(() => getRemoteEnv()).toThrow(/FIRECRACKER_RUNNER_TLS_REQUIRED/);
  });

  it("parses (warn-only) when FIRECRACKER_RUNNER_TLS_REQUIRED is unset", () => {
    setEnv("http://10.0.0.5:3100");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("http://10.0.0.5:3100");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(false);
  });

  it("accepts an https URL with FIRECRACKER_RUNNER_TLS_REQUIRED=1", () => {
    setEnv("https://runner.internal:3100", "1");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("https://runner.internal:3100");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(true);
  });
});
