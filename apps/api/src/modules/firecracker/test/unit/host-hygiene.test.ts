// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's boot-time host-hygiene advisory
 * (runner/host-hygiene.ts). An injectable read function stands in for
 * sysfs/procfs — no Linux host required.
 */

import { describe, it, expect } from "bun:test";
import {
  checkHostHygiene,
  type HygieneLogger,
  type ReadHostFile,
} from "../../runner/host-hygiene.ts";

/** Records warn calls for assertions. */
function fakeLogger(): {
  logger: HygieneLogger;
  warns: { msg: string; data?: Record<string, unknown> }[];
} {
  const warns: { msg: string; data?: Record<string, unknown> }[] = [];
  return {
    warns,
    logger: { warn: (msg, data) => warns.push({ msg, ...(data !== undefined ? { data } : {}) }) },
  };
}

const SWAPS_HEADER = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority";

/** Read fn backed by a path→content map; unknown paths throw like ENOENT. */
function readFromMap(files: Record<string, string>): ReadHostFile {
  return async (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return content;
  };
}

/** A fully hygienic host: SMT off, KSM off, swap header only. */
function cleanFiles(): Record<string, string> {
  return {
    "/sys/devices/system/cpu/smt/control": "off\n",
    "/sys/kernel/mm/ksm/run": "0\n",
    "/proc/swaps": `${SWAPS_HEADER}\n`,
  };
}

describe("checkHostHygiene", () => {
  it("emits no warnings on a clean host", async () => {
    const { logger, warns } = fakeLogger();
    await checkHostHygiene({ logger, readHostFile: readFromMap(cleanFiles()) });
    expect(warns).toEqual([]);
  });

  it("warns when SMT is enabled, with the nosmt remediation", async () => {
    const { logger, warns } = fakeLogger();
    const files = cleanFiles();
    files["/sys/devices/system/cpu/smt/control"] = "on\n";
    await checkHostHygiene({ logger, readHostFile: readFromMap(files) });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("SMT");
    expect(warns[0]?.msg).toContain("nosmt");
    expect(warns[0]?.msg).toContain("docs/architecture/FIRECRACKER.md");
    expect(warns[0]?.data).toMatchObject({ check: "smt" });
  });

  it("does not warn on non-'on' SMT states (forceoff, notsupported, notimplemented)", async () => {
    for (const value of ["forceoff", "notsupported", "notimplemented"]) {
      const { logger, warns } = fakeLogger();
      const files = cleanFiles();
      files["/sys/devices/system/cpu/smt/control"] = `${value}\n`;
      await checkHostHygiene({ logger, readHostFile: readFromMap(files) });
      expect(warns).toEqual([]);
    }
  });

  it("warns when KSM is enabled, with the echo-0 remediation", async () => {
    const { logger, warns } = fakeLogger();
    const files = cleanFiles();
    files["/sys/kernel/mm/ksm/run"] = "1\n";
    await checkHostHygiene({ logger, readHostFile: readFromMap(files) });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("KSM");
    expect(warns[0]?.msg).toContain("echo 0 > /sys/kernel/mm/ksm/run");
    expect(warns[0]?.msg).toContain("docs/architecture/FIRECRACKER.md");
    expect(warns[0]?.data).toMatchObject({ check: "ksm" });
  });

  it("warns when swap is active, with the swapoff remediation", async () => {
    const { logger, warns } = fakeLogger();
    const files = cleanFiles();
    files["/proc/swaps"] = `${SWAPS_HEADER}\n/dev/sda2\tpartition\t8388604\t0\t-2\n`;
    await checkHostHygiene({ logger, readHostFile: readFromMap(files) });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("swap");
    expect(warns[0]?.msg).toContain("swapoff -a");
    expect(warns[0]?.msg).toContain("docs/architecture/FIRECRACKER.md");
    expect(warns[0]?.data).toMatchObject({ check: "swap", devices: 1 });
  });

  it("emits one warning per violation when all three are violated", async () => {
    const { logger, warns } = fakeLogger();
    await checkHostHygiene({
      logger,
      readHostFile: readFromMap({
        "/sys/devices/system/cpu/smt/control": "on\n",
        "/sys/kernel/mm/ksm/run": "1\n",
        "/proc/swaps": `${SWAPS_HEADER}\n/dev/sda2\tpartition\t8388604\t0\t-2\n`,
      }),
    });
    expect(warns).toHaveLength(3);
    expect(warns.map((w) => w.data?.check)).toEqual(["smt", "ksm", "swap"]);
  });

  it("silently skips unreadable files — no warns, no throw (macOS dev, containers)", async () => {
    const { logger, warns } = fakeLogger();
    const readNothing: ReadHostFile = async (path) => {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    };
    await checkHostHygiene({ logger, readHostFile: readNothing });
    expect(warns).toEqual([]);
  });

  it("skips only the unreadable check and still warns on the readable ones", async () => {
    const { logger, warns } = fakeLogger();
    await checkHostHygiene({
      logger,
      // SMT knob absent (common in VMs), KSM enabled, swap file readable+clean.
      readHostFile: readFromMap({
        "/sys/kernel/mm/ksm/run": "1\n",
        "/proc/swaps": `${SWAPS_HEADER}\n`,
      }),
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data).toMatchObject({ check: "ksm" });
  });
});
