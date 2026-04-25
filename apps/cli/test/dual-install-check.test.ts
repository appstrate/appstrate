// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  ackDualInstall,
  runDualInstallCheck,
  shouldSkipDualInstallCheck,
  type AckStore,
  type DualInstallAck,
} from "../src/lib/dual-install-check.ts";
import type { PathScanFs } from "../src/lib/path-scan.ts";

/**
 * Phase 5 — runtime dual-install warning (issue #249).
 *
 * The check is wired into `cli.ts` via a `preAction` hook. Tests here
 * exercise the pure logic with stubbed PATH + ack store — no file I/O,
 * no subprocess, no real PATH probe.
 */

function fs(map: Record<string, { exec: boolean; real?: string }>): PathScanFs {
  return {
    async isExecutable(p) {
      return map[p]?.exec ?? false;
    },
    async realpath(p) {
      return map[p]?.real ?? p;
    },
  };
}

function memStore(
  initial: DualInstallAck | null = null,
): AckStore & { last: DualInstallAck | null } {
  const store: AckStore & { last: DualInstallAck | null } = {
    last: initial,
    async read() {
      return store.last;
    },
    async write(ack) {
      store.last = ack;
    },
  };
  return store;
}

describe("shouldSkipDualInstallCheck", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK;
    delete process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK;
    else process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK = originalEnv;
  });

  it("skips when APPSTRATE_NO_DUAL_INSTALL_CHECK=1", () => {
    process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK = "1";
    expect(shouldSkipDualInstallCheck({ args: ["whoami"], rawArgv: ["whoami"] })).toBe(true);
  });

  it("skips for --version and -V", () => {
    expect(shouldSkipDualInstallCheck({ args: [], rawArgv: ["--version"] })).toBe(true);
    expect(shouldSkipDualInstallCheck({ args: [], rawArgv: ["-V"] })).toBe(true);
  });

  it("skips for --help and -h", () => {
    expect(shouldSkipDualInstallCheck({ args: [], rawArgv: ["--help"] })).toBe(true);
    expect(shouldSkipDualInstallCheck({ args: ["whoami"], rawArgv: ["whoami", "-h"] })).toBe(true);
  });

  it("skips for `doctor`, `completion`, `__install-source`", () => {
    expect(shouldSkipDualInstallCheck({ args: ["doctor"], rawArgv: ["doctor"] })).toBe(true);
    expect(shouldSkipDualInstallCheck({ args: ["completion"], rawArgv: ["completion"] })).toBe(
      true,
    );
    expect(
      shouldSkipDualInstallCheck({ args: ["__install-source"], rawArgv: ["__install-source"] }),
    ).toBe(true);
  });

  it("does NOT skip for normal subcommands", () => {
    expect(shouldSkipDualInstallCheck({ args: ["whoami"], rawArgv: ["whoami"] })).toBe(false);
    expect(shouldSkipDualInstallCheck({ args: ["login"], rawArgv: ["login"] })).toBe(false);
    expect(shouldSkipDualInstallCheck({ args: ["self-update"], rawArgv: ["self-update"] })).toBe(
      false,
    );
  });
});

describe("runDualInstallCheck", () => {
  it("returns null when only one installation exists", async () => {
    const out = await runDualInstallCheck({
      pathEnv: "/a",
      pathScanFs: fs({ "/a/appstrate": { exec: true } }),
      ackStore: memStore(),
    });
    expect(out).toBeNull();
  });

  it("returns null when zero installations exist", async () => {
    const out = await runDualInstallCheck({
      pathEnv: "/empty",
      pathScanFs: fs({}),
      ackStore: memStore(),
    });
    expect(out).toBeNull();
  });

  it("returns a warning on first detection of dual-install", async () => {
    const out = await runDualInstallCheck({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
      }),
      ackStore: memStore(),
    });
    expect(out).not.toBeNull();
    expect(out!.message).toContain("Multiple `appstrate` installations detected");
    expect(out!.message).toContain("/a/appstrate");
    expect(out!.message).toContain("/b/appstrate");
    expect(out!.message).toContain("appstrate doctor");
    expect(out!.paths.sort()).toEqual(["/a/appstrate", "/b/appstrate"]);
  });

  it("stays silent on the second run after ack (same install set)", async () => {
    const store = memStore();
    const first = await runDualInstallCheck({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
      }),
      ackStore: store,
    });
    expect(first).not.toBeNull();
    await ackDualInstall(first!.paths, store);
    const second = await runDualInstallCheck({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
      }),
      ackStore: store,
    });
    expect(second).toBeNull();
  });

  it("re-warns when the install set changes (new path appears)", async () => {
    const store = memStore({
      paths: ["/a/appstrate", "/b/appstrate"],
      warnedAt: new Date().toISOString(),
    });
    const out = await runDualInstallCheck({
      pathEnv: "/a:/b:/c",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
        "/c/appstrate": { exec: true },
      }),
      ackStore: store,
    });
    expect(out).not.toBeNull();
    expect(out!.paths).toContain("/c/appstrate");
  });

  it("re-warns when the install set changes (path removed)", async () => {
    const store = memStore({
      paths: ["/a/appstrate", "/b/appstrate", "/c/appstrate"],
      warnedAt: new Date().toISOString(),
    });
    const out = await runDualInstallCheck({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true },
        "/b/appstrate": { exec: true },
      }),
      ackStore: store,
    });
    expect(out).not.toBeNull();
  });

  it("dedupes by realpath so symlink chains are not reported as dual-install", async () => {
    const out = await runDualInstallCheck({
      pathEnv: "/a:/b",
      pathScanFs: fs({
        "/a/appstrate": { exec: true, real: "/opt/appstrate/bin/appstrate" },
        "/b/appstrate": { exec: true, real: "/opt/appstrate/bin/appstrate" },
      }),
      ackStore: memStore(),
    });
    expect(out).toBeNull();
  });
});

describe("ackDualInstall", () => {
  it("writes a sorted, timestamped ack", async () => {
    const store = memStore();
    const fixedDate = new Date("2026-04-24T10:00:00Z");
    await ackDualInstall(["/b/appstrate", "/a/appstrate"], store, () => fixedDate);
    expect(store.last).toEqual({
      paths: ["/a/appstrate", "/b/appstrate"],
      warnedAt: "2026-04-24T10:00:00.000Z",
    });
  });
});
