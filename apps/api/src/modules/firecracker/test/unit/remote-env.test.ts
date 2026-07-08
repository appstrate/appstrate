// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the platform-side remote-runner env (remote-env.ts):
 * the SEC-2 transport-security gate (P1-5, fail-closed). The
 * platform↔daemon wire carries the bearer token plus per-run credentials,
 * so plaintext http:// to a NON-loopback daemon is REFUSED by default —
 * the only escape is an explicit FIRECRACKER_RUNNER_TLS_REQUIRED=0
 * (trusted private link), which downgrades the refusal to a loud warning.
 * Loopback http:// and https:// always pass.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  assertRunnerTransportSecurity,
  getRemoteEnv,
  parseRunnerTransport,
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

describe("parseRunnerTransport", () => {
  it("classifies unix:///abs/path.sock as a unix transport with the verbatim path", () => {
    expect(parseRunnerTransport("unix:///run/appstrate-runner/runner.sock")).toEqual({
      kind: "unix",
      socketPath: "/run/appstrate-runner/runner.sock",
    });
  });

  it("classifies http(s) as tcp, stripping trailing slashes (http only concern)", () => {
    expect(parseRunnerTransport("http://127.0.0.1:3100/")).toEqual({
      kind: "tcp",
      url: "http://127.0.0.1:3100",
    });
    expect(parseRunnerTransport("https://runner.internal:3100")).toEqual({
      kind: "tcp",
      url: "https://runner.internal:3100",
    });
  });

  it("rejects the two-slash typo (host component) with the three-slash hint", () => {
    // unix://var/run/x.sock parses "var" as a hostname — dialing
    // /run/x.sock instead of /var/run/x.sock would be a silent misroute.
    expect(() => parseRunnerTransport("unix://var/run/x.sock")).toThrow(/THREE slashes/);
    expect(() => parseRunnerTransport("unix://var/run/x.sock")).toThrow(
      /unix:\/\/\/var\/run\/x\.sock/,
    );
  });

  it("rejects a unix:// URL without a socket path", () => {
    expect(() => parseRunnerTransport("unix://")).toThrow(/absolute socket path/);
  });

  it("decodes a percent-encoded socket path (URL pathname is encoded)", () => {
    // "/run/my dir/runner.sock" round-trips through URL as "%20" — the
    // path we dial must be byte-identical to the filesystem node.
    expect(parseRunnerTransport("unix:///run/my%20dir/runner.sock")).toEqual({
      kind: "unix",
      socketPath: "/run/my dir/runner.sock",
    });
  });

  it("rejects a unix:// URL carrying a query or fragment (silently dropped otherwise)", () => {
    expect(() => parseRunnerTransport("unix:///run/x.sock?foo=1")).toThrow(/bare socket path/);
    expect(() => parseRunnerTransport("unix:///run/x.sock#frag")).toThrow(/bare socket path/);
  });

  it("rejects unsupported protocols with the accepted alternatives", () => {
    expect(() => parseRunnerTransport("ftp://runner:3100")).toThrow(/http\(s\)/);
  });
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

  it("passes a unix:// URL silently even with tlsRequired — no network path exists", () => {
    const warnings: string[] = [];
    expect(() =>
      assertRunnerTransportSecurity("unix:///run/appstrate-runner/runner.sock", true, (m) =>
        warnings.push(m),
      ),
    ).not.toThrow();
    expect(warnings).toEqual([]);
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

  it("refuses a plaintext non-loopback URL when FIRECRACKER_RUNNER_TLS_REQUIRED is unset (secure by default)", () => {
    setEnv("http://10.0.0.5:3100");
    expect(() => getRemoteEnv()).toThrow(/FIRECRACKER_RUNNER_TLS_REQUIRED/);
  });

  it("parses (warn-only) when FIRECRACKER_RUNNER_TLS_REQUIRED=0 is set explicitly", () => {
    setEnv("http://10.0.0.5:3100", "0");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("http://10.0.0.5:3100");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(false);
  });

  it("parses loopback http:// without the escape hatch (always allowed)", () => {
    setEnv("http://127.0.0.1:3100");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("http://127.0.0.1:3100");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(true);
  });

  it("accepts an https URL with FIRECRACKER_RUNNER_TLS_REQUIRED=1", () => {
    setEnv("https://runner.internal:3100", "1");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("https://runner.internal:3100");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(true);
  });

  it("derives a tcp transport for an http(s) URL", () => {
    setEnv("https://runner.internal:3100");
    expect(getRemoteEnv().transport).toEqual({ kind: "tcp", url: "https://runner.internal:3100" });
  });

  it("accepts unix:/// with tlsRequired defaulted on — the gate never applies to a UDS", () => {
    // The exact self-host topology the transport exists for: no escape
    // hatch, no warning, straight through the fail-closed default.
    setEnv("unix:///run/appstrate-runner/runner.sock");
    const env = getRemoteEnv();
    expect(env.FIRECRACKER_RUNNER_URL).toBe("unix:///run/appstrate-runner/runner.sock");
    expect(env.FIRECRACKER_RUNNER_TLS_REQUIRED).toBe(true);
    expect(env.transport).toEqual({
      kind: "unix",
      socketPath: "/run/appstrate-runner/runner.sock",
    });
  });

  it("rejects the two-slash unix typo at parse time with the three-slash hint", () => {
    setEnv("unix://var/run/x.sock");
    expect(() => getRemoteEnv()).toThrow(/THREE slashes/);
  });

  it("rejects a unix:// URL with an empty socket path", () => {
    setEnv("unix://");
    expect(() => getRemoteEnv()).toThrow(/absolute socket path/);
  });
});
