// SPDX-License-Identifier: Apache-2.0

/**
 * `scanSshHostKey` decides three things: whether the target is allowed to be
 * reached at all, which key to keep when the server offers several, and how
 * each failure reads. The first is exercised against the real SSRF floor —
 * a stubbed floor would test the stub — and the rest through the `runKeyscan`
 * and `resolveHost` seams, so no test here needs a server.
 *
 * Which floor, and why it is the point of this file: the host has to be
 * reachable by the integration RUNNER, whose CONNECT egress listener honours
 * NO operator allowlist. So `EGRESS_ALLOW_INTERNAL_HOSTS` must NOT open this
 * path — a connection created on the looser floor passes the form and then
 * fails every single run.
 */

import { describe, it, expect } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { scanSshHostKey } from "../../src/lib/ssh-host-key.ts";

/** A scanner that answers with fixed output, recording the argv it was given. */
function stubScanner(stdout: string, stderr = "", code = 0) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return { stdout, stderr, code };
    },
  };
}

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPBj/sOdBfKkpuneRA7h6SaW8fRXZly/zo3c50YJVhE9";
const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDLONGBASE64BLOBHERE";

/**
 * Run with the operator allowlist EMPTY. The API test harness preloads
 * `EGRESS_ALLOW_INTERNAL_HOSTS` with a long list for the OAuth/MCP suites —
 * `127.0.0.1` and `localhost` included — so asserting the floor against the
 * ambient value would assert the harness, not the guard.
 */
async function withoutAllowlist<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
  delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
  resetEnvCache();
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.EGRESS_ALLOW_INTERNAL_HOSTS = prev;
    resetEnvCache();
  }
}

describe("scanSshHostKey — egress floor", () => {
  it("refuses a loopback target", async () => {
    const scanner = stubScanner(`127.0.0.1 ${ED25519}`);
    const res = await withoutAllowlist(() =>
      scanSshHostKey("127.0.0.1", 22, { runKeyscan: scanner.run }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("blocked-host");
    // The floor must decide BEFORE the scan — otherwise a blocked host still
    // gets a connection attempt from the platform.
    expect(scanner.calls).toHaveLength(0);
  });

  it("refuses an RFC1918 target", async () => {
    const scanner = stubScanner(`10.0.0.5 ${ED25519}`);
    const res = await withoutAllowlist(() =>
      scanSshHostKey("10.0.0.5", 22, { runKeyscan: scanner.run }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("blocked-host");
    expect(scanner.calls).toHaveLength(0);
  });

  it("refuses the cloud metadata address", async () => {
    const res = await withoutAllowlist(() =>
      scanSshHostKey("169.254.169.254", 22, { runKeyscan: stubScanner("").run }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("blocked-host");
  });

  it("refuses a loopback literal the operator allowlists", async () => {
    const scanner = stubScanner(`127.0.0.1 ${ED25519}`);
    // The harness's own preload already trusts 127.0.0.1 — and that must not
    // matter here. `checkEgressHost` would let this through; the runner would
    // not, so this path uses the bare resolving floor instead.
    const res = await scanSshHostKey("127.0.0.1", 22, { runKeyscan: scanner.run });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("blocked-host");
    expect(scanner.calls).toHaveLength(0);
  });

  /**
   * The case a no-DNS blocklist structurally cannot see, and the one an
   * operator actually writes: `EGRESS_ALLOW_INTERNAL_HOSTS` holds HOSTNAMES
   * (docs/ENV.md), and a hostname trips no literal check. Only the resolving
   * gate can refuse it — and only if it ignores the allowlist.
   */
  it("refuses an allowlisted NAME that resolves to a private address", async () => {
    const scanner = stubScanner(`nas.internal.example ${ED25519}`);
    const prev = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
    process.env.EGRESS_ALLOW_INTERNAL_HOSTS = "nas.internal.example";
    resetEnvCache();
    try {
      const res = await scanSshHostKey("nas.internal.example", 22, {
        runKeyscan: scanner.run,
        resolveHost: async () => ["10.4.5.6"],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("blocked-host");
      expect(scanner.calls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
      else process.env.EGRESS_ALLOW_INTERNAL_HOSTS = prev;
      resetEnvCache();
    }
  });

  it("reads a name that does not resolve as unreachable, not as blocked", async () => {
    // "Blocked" sends someone hunting for a firewall rule; a typo is a typo.
    const res = await scanSshHostKey("nope.example.test", 22, {
      runKeyscan: stubScanner("").run,
      resolveHost: async () => {
        throw new Error("queryA ENOTFOUND nope.example.test");
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unreachable");
      expect(res.detail).toMatch(/ENOTFOUND/);
    }
  });
});

describe("scanSshHostKey — port validation", () => {
  it.each([0, 65536, 1.5, -1])("refuses port %p without scanning", async (port) => {
    const scanner = stubScanner(`example.test ${ED25519}`);
    const res = await scanSshHostKey("example.test", port as number, { runKeyscan: scanner.run });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/between 1 and 65535/);
    expect(scanner.calls).toHaveLength(0);
  });
});

/**
 * The selection and failure paths need a host that survives the SSRF floor.
 * Since that floor no longer takes an operator escape hatch, they drive it
 * through the `resolveHost` seam with a publicly-routable answer — the real
 * gate still runs, only the DNS lookup is supplied.
 */
describe("scanSshHostKey — key selection", () => {
  const allowed = "ssh-target.example";
  /** What the stubbed resolver answers, and therefore what the scan must dial. */
  const PINNED = "203.0.113.24";
  const withResolver = <T>(fn: (resolveHost: () => Promise<string[]>) => Promise<T>): Promise<T> =>
    fn(async () => [PINNED]);

  it("keeps ed25519 when the server offers both, and drops the host column", async () => {
    const scanner = stubScanner(
      `# ${allowed}:22 SSH-2.0-OpenSSH_9.7\n${allowed} ${RSA}\n${allowed} ${ED25519}\n`,
    );
    const res = await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 22, { runKeyscan: scanner.run, resolveHost }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hostKey).toBe(ED25519);
      expect(res.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    }
  });

  it("falls back to rsa when ed25519 is not offered", async () => {
    const scanner = stubScanner(`${allowed} ${RSA}\n`);
    const res = await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 22, { runKeyscan: scanner.run, resolveHost }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.hostKey).toBe(RSA);
  });

  it("passes the port and a bounded timeout to the scanner", async () => {
    const scanner = stubScanner(`${allowed} ${ED25519}\n`);
    await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 2222, { runKeyscan: scanner.run, resolveHost }),
    );
    const argv = scanner.calls[0]!;
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toBe("2222");
    expect(argv).toContain("-T");
    // The target is the last argument, it is the address the gate PINNED (not
    // the name — resolving twice reopens the rebind window), and it is never
    // shell-interpolated.
    expect(argv[argv.length - 1]).toBe(PINNED);
  });

  it("reports an unreachable host distinctly from a host that answered", async () => {
    const empty = stubScanner("", "", 0);
    const unreachable = await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 22, { runKeyscan: empty.run, resolveHost }),
    );
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.reason).toBe("unreachable");

    // Answered, but with nothing we are willing to pin (e.g. ssh-dss only).
    const dssOnly = stubScanner(`${allowed} ssh-dss AAAAB3NzaC1kc3MAAACB\n`);
    const noKey = await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 22, { runKeyscan: dssOnly.run, resolveHost }),
    );
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.reason).toBe("no-key");
  });

  it("does not read a missing scanner binary as an unreachable server", async () => {
    const res = await withResolver((resolveHost) =>
      scanSshHostKey(allowed, 22, {
        resolveHost,
        runKeyscan: async () => {
          throw new Error("spawn ssh-keyscan ENOENT");
        },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/scanner is unavailable/);
  });
});
