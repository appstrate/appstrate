// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the jailer confinement helpers (jail.ts): jail-id
 * derivation (jailer charset + collision-proofing), the chroot layout,
 * the AF_UNIX socket-length guard, the jailer argv shape, and the
 * chroot-prep fs choreography (hardlinks, EXDEV fallbacks, secret
 * ownership). All pure or fake-fs-driven — no root, no KVM, no Linux.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
  assertApiSocketPathLength,
  assertJailerVersionParity,
  buildJailerArgv,
  computeJailPaths,
  deriveJailId,
  fcExecName,
  jailChrootBase,
  placeChrootSecret,
  prepareChrootArtifacts,
  removeJailDir,
  writeChrootVmConfig,
  CHROOT_API_SOCKET_PATH,
  CHROOT_CONFIG_DRIVE_PATH,
  CHROOT_KERNEL_PATH,
  CHROOT_ROOTFS_PATH,
  CHROOT_VMCONFIG_PATH,
  JAIL_CPU_PERIOD_MICROS,
  MAX_API_SOCKET_PATH_BYTES,
  type JailFs,
} from "../../jail.ts";

/** Recording JailFs fake — every op succeeds unless `fail` matches it. */
function fakeJailFs(fail?: { op: keyof JailFs; code: string; oncePath?: string }): {
  fs: JailFs;
  ops: string[];
} {
  const ops: string[] = [];
  const maybeFail = (op: keyof JailFs, path: string): void => {
    if (fail && fail.op === op && (fail.oncePath === undefined || fail.oncePath === path)) {
      const err = new Error(`${fail.code}: fake`) as NodeJS.ErrnoException;
      err.code = fail.code;
      throw err;
    }
  };
  const fs: JailFs = {
    async mkdir(path, opts) {
      ops.push(`mkdir ${path} mode=${opts.mode.toString(8)}`);
      maybeFail("mkdir", path);
    },
    async link(existing, dest) {
      ops.push(`link ${existing} -> ${dest}`);
      maybeFail("link", dest);
    },
    async rename(from, to) {
      ops.push(`rename ${from} -> ${to}`);
      maybeFail("rename", to);
    },
    async copyFile(from, to) {
      ops.push(`copyFile ${from} -> ${to}`);
      maybeFail("copyFile", to);
    },
    async chown(path, uid, gid) {
      ops.push(`chown ${path} ${uid}:${gid}`);
      maybeFail("chown", path);
    },
    async chmod(path, mode) {
      ops.push(`chmod ${path} ${mode.toString(8)}`);
      maybeFail("chmod", path);
    },
    async rm(path, opts) {
      ops.push(`rm ${path}${opts.recursive ? " -r" : ""}`);
      maybeFail("rm", path);
    },
    async writeFile(path, _data, opts) {
      ops.push(`writeFile ${path} mode=${opts.mode.toString(8)}`);
      maybeFail("writeFile", path);
    },
  };
  return { fs, ops };
}

describe("deriveJailId", () => {
  it("derives a short, deterministic, jailer-charset id (digest + subnet index)", () => {
    const id = deriveJailId("run_9f0c2b1a-1234-5678-9abc-def012345678", 7);
    expect(id).toBe(deriveJailId("run_9f0c2b1a-1234-5678-9abc-def012345678", 7));
    expect(/^fc-[0-9a-f]{12}-7$/.test(id)).toBe(true);
    expect(/^[a-zA-Z0-9-]{1,64}$/.test(id)).toBe(true);
  });

  it("differs across distinct runIds and across indexes", () => {
    expect(deriveJailId("run_1", 3)).not.toBe(deriveJailId("run.1", 3));
    expect(deriveJailId("run_1", 3)).not.toBe(deriveJailId("run_1", 4));
  });

  it("stays short regardless of the runId length (socket-path budget)", () => {
    const id = deriveJailId("x".repeat(200), 16319);
    expect(id.length).toBeLessThanOrEqual(3 + 12 + 1 + 5);
    expect(id.endsWith("-16319")).toBe(true);
  });
});

describe("computeJailPaths", () => {
  const input = {
    dataDir: "/var/lib/fc/runs",
    fcExecName: "firecracker",
    runId: "run_42",
    subnetIndex: 5,
    uidBase: 64_000,
  };
  const jailId = deriveJailId("run_42", 5);

  it("lays out the jailer-conventional chroot tree beside the runs dir", () => {
    const paths = computeJailPaths(input);
    expect(paths.jailId).toBe(jailId);
    expect(paths.uid).toBe(64_005);
    expect(paths.gid).toBe(64_005);
    expect(paths.chrootBaseDir).toBe("/var/lib/fc/jail");
    expect(paths.jailDir).toBe(`/var/lib/fc/jail/firecracker/${jailId}`);
    expect(paths.rootDir).toBe(`/var/lib/fc/jail/firecracker/${jailId}/root`);
    expect(paths.apiSocketHostPath).toBe(
      `/var/lib/fc/jail/firecracker/${jailId}/root/run/firecracker.socket`,
    );
  });

  it("nests the chroot under the exec-file basename (jailer layout contract)", () => {
    const paths = computeJailPaths({ ...input, fcExecName: "firecracker-v1.16.0" });
    expect(paths.jailDir).toBe(`/var/lib/fc/jail/firecracker-v1.16.0/${jailId}`);
  });

  it("fits the AF_UNIX socket cap with a REAL run id under the production layout (B-2)", () => {
    // Installer defaults (/var/lib/appstrate-runner/runs) + the platform's
    // actual `run_<uuid>` id shape — the pre-digest jailId derivation blew
    // the ~108-byte sun_path cap here and refused 100% of jailed prod runs.
    // Only toy ids like "run-42" kept the old tests green.
    const paths = computeJailPaths({
      dataDir: "/var/lib/appstrate-runner/runs",
      fcExecName: "firecracker",
      runId: `run_${crypto.randomUUID()}`,
      subnetIndex: 16319,
      uidBase: 200_000,
    });
    expect(Buffer.byteLength(paths.apiSocketHostPath)).toBeLessThan(MAX_API_SOCKET_PATH_BYTES);
  });

  it("throws the operator-facing error when the socket path would exceed the AF_UNIX cap", () => {
    expect(() => computeJailPaths({ ...input, dataDir: `/${"d".repeat(120)}/runs` })).toThrow(
      /AF_UNIX.*FIRECRACKER_DATA_DIR/s,
    );
  });
});

describe("assertApiSocketPathLength", () => {
  it("admits paths strictly under the cap and rejects at the cap", () => {
    expect(() =>
      assertApiSocketPathLength("/" + "a".repeat(MAX_API_SOCKET_PATH_BYTES - 2)),
    ).not.toThrow();
    expect(() => assertApiSocketPathLength("/" + "a".repeat(MAX_API_SOCKET_PATH_BYTES))).toThrow(
      /AF_UNIX/,
    );
  });

  it("counts BYTES, not code units (multibyte data dirs)", () => {
    expect(() => assertApiSocketPathLength("/é".repeat(60))).toThrow(/AF_UNIX/);
  });
});

describe("buildJailerArgv", () => {
  const jail = {
    jailId: "run-1-1",
    uid: 64_001,
    gid: 64_001,
    chrootBaseDir: "/var/lib/fc/jail",
  };

  it("builds the full flag set with cgroup bounds and chroot-relative firecracker args", () => {
    const argv = buildJailerArgv({
      jailerBin: "/usr/local/bin/jailer",
      fcBin: "/usr/local/bin/firecracker",
      jail,
      cgroups: { memoryMaxBytes: 1_073_741_824, pidsMax: 1000, vcpuCount: 4 },
    });
    expect(argv).toEqual([
      "/usr/local/bin/jailer",
      "--id",
      "run-1-1",
      "--exec-file",
      "/usr/local/bin/firecracker",
      "--uid",
      "64001",
      "--gid",
      "64001",
      "--chroot-base-dir",
      "/var/lib/fc/jail",
      "--parent-cgroup",
      "appstrate-fc",
      "--cgroup-version",
      "2",
      "--cgroup",
      "memory.max=1073741824",
      "--cgroup",
      "pids.max=1000",
      "--cgroup",
      // cgroup-v2 "QUOTA PERIOD": 4 vCPUs × the 100 ms period — the VM
      // gets exactly its vCPUs' worth of CPU time, never the whole host.
      "cpu.max=400000 100000",
      "--",
      "--api-sock",
      CHROOT_API_SOCKET_PATH,
      "--config-file",
      CHROOT_VMCONFIG_PATH,
    ]);
  });

  it("scales the cpu.max quota with the vCPU count (B6)", () => {
    const argv = buildJailerArgv({
      jailerBin: "jailer",
      fcBin: "/x/firecracker",
      jail,
      cgroups: { memoryMaxBytes: 1, pidsMax: 1, vcpuCount: 8 },
    });
    const quota = 8 * JAIL_CPU_PERIOD_MICROS;
    const at = argv.indexOf(`cpu.max=${quota} ${JAIL_CPU_PERIOD_MICROS}`);
    expect(at).toBeGreaterThan(0);
    expect(argv[at - 1]).toBe("--cgroup");
  });

  it("drops every cgroup flag when cgroups are disabled (FIRECRACKER_JAIL_CGROUPS=off)", () => {
    const argv = buildJailerArgv({ jailerBin: "jailer", fcBin: "/x/firecracker", jail });
    expect(argv.join(" ")).not.toContain("--cgroup");
    expect(argv.join(" ")).not.toContain("--parent-cgroup");
    expect(argv.join(" ")).not.toContain("cpu.max");
    expect(argv).toContain("--");
  });

  it("forwards extra firecracker flags after the -- separator (MMDS size overrides)", () => {
    const argv = buildJailerArgv({
      jailerBin: "jailer",
      fcBin: "/x/firecracker",
      jail,
      extraFcArgs: ["--mmds-size-limit", "123456", "--http-api-max-payload-size", "123456"],
    });
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1, sep + 5)).toEqual([
      "--mmds-size-limit",
      "123456",
      "--http-api-max-payload-size",
      "123456",
    ]);
    // The fixed api-sock/config-file pair still closes the argv.
    expect(argv.slice(-4)).toEqual([
      "--api-sock",
      CHROOT_API_SOCKET_PATH,
      "--config-file",
      CHROOT_VMCONFIG_PATH,
    ]);
  });

  it("never detaches the VMM from the spawn handle (no daemonize / pid-ns / netns)", () => {
    // --daemonize redirects stdio to /dev/null and setsid()s; with
    // --new-pid-ns the PARENT jailer exits 0 immediately without
    // waitpid — either would break `proc.exited` + console capture.
    // --netns is deferred (TAP stays on the host in this pass).
    const argv = buildJailerArgv({ jailerBin: "jailer", fcBin: "/x/firecracker", jail });
    expect(argv).not.toContain("--daemonize");
    expect(argv).not.toContain("--new-pid-ns");
    expect(argv).not.toContain("--netns");
  });
});

describe("assertJailerVersionParity", () => {
  it("accepts matching releases regardless of the surrounding text", () => {
    expect(() => assertJailerVersionParity("Firecracker v1.16.0", "Jailer v1.16.0")).not.toThrow();
  });

  it("rejects a version mismatch (env override bypassing the installer lockstep)", () => {
    expect(() => assertJailerVersionParity("Firecracker v1.16.0", "Jailer v1.15.1")).toThrow(
      /same upstream release/,
    );
  });

  it("rejects unparseable probes — no parity proof, no pass", () => {
    expect(() => assertJailerVersionParity("Firecracker v1.16.0", "garbage")).toThrow(
      /version parity/,
    );
    expect(() => assertJailerVersionParity("", "Jailer v1.16.0")).toThrow(/version parity/);
  });
});

describe("prepareChrootArtifacts", () => {
  const opts = {
    rootDir: "/jail/firecracker/run-1-1/root",
    kernelPath: "/data/vmlinux",
    rootfsPath: "/data/rootfs.ext4",
  };

  it("creates the root and hardlinks (never copies) both artifacts under fixed names", async () => {
    const { fs, ops } = fakeJailFs();
    await prepareChrootArtifacts(opts, fs);
    expect(ops).toEqual([
      "mkdir /jail/firecracker/run-1-1/root mode=700",
      `rm ${join(opts.rootDir, CHROOT_KERNEL_PATH)}`,
      `link /data/vmlinux -> ${join(opts.rootDir, CHROOT_KERNEL_PATH)}`,
      `rm ${join(opts.rootDir, CHROOT_ROOTFS_PATH)}`,
      `link /data/rootfs.ext4 -> ${join(opts.rootDir, CHROOT_ROOTFS_PATH)}`,
    ]);
  });

  it("turns a cross-filesystem hardlink (EXDEV) into the same-filesystem operator error", async () => {
    const { fs } = fakeJailFs({ op: "link", code: "EXDEV" });
    await expect(prepareChrootArtifacts(opts, fs)).rejects.toThrow(
      /DIFFERENT filesystems.*FIRECRACKER_KERNEL_PATH/s,
    );
  });

  it("rethrows non-EXDEV link failures untouched", async () => {
    const { fs } = fakeJailFs({ op: "link", code: "EACCES" });
    await expect(prepareChrootArtifacts(opts, fs)).rejects.toThrow(/EACCES/);
  });
});

describe("placeChrootSecret", () => {
  const opts = {
    from: "/runs/run_1/config.img",
    to: "/jail/firecracker/run-1-1/root/config.img",
    uid: 64_001,
    gid: 64_001,
  };

  it("renames (no secret copy), then locks ownership to the jail uid, 0400", async () => {
    const { fs, ops } = fakeJailFs();
    await placeChrootSecret(opts, fs);
    expect(ops).toEqual([
      `rm ${opts.to}`,
      `rename ${opts.from} -> ${opts.to}`,
      `chown ${opts.to} 64001:64001`,
      `chmod ${opts.to} 400`,
    ]);
  });

  it("falls back to copy+delete across filesystems (tmpfs data dir)", async () => {
    const { fs, ops } = fakeJailFs({ op: "rename", code: "EXDEV" });
    await placeChrootSecret(opts, fs);
    expect(ops).toEqual([
      `rm ${opts.to}`,
      `rename ${opts.from} -> ${opts.to}`,
      `copyFile ${opts.from} -> ${opts.to}`,
      `rm ${opts.from}`,
      `chown ${opts.to} 64001:64001`,
      `chmod ${opts.to} 400`,
    ]);
  });

  it("rethrows non-EXDEV rename failures untouched", async () => {
    const { fs, ops } = fakeJailFs({ op: "rename", code: "EACCES" });
    await expect(placeChrootSecret(opts, fs)).rejects.toThrow(/EACCES/);
    expect(ops.some((op) => op.startsWith("copyFile"))).toBe(false);
  });
});

describe("writeChrootVmConfig", () => {
  it("writes the config inside the chroot and hands it to the jail uid (read post-drop)", async () => {
    const { fs, ops } = fakeJailFs();
    await writeChrootVmConfig(
      { rootDir: "/jail/x/root", vmConfig: { "machine-config": {} }, uid: 64_002, gid: 64_002 },
      fs,
    );
    expect(ops).toEqual([
      `writeFile /jail/x/root${CHROOT_VMCONFIG_PATH} mode=600`,
      `chown /jail/x/root${CHROOT_VMCONFIG_PATH} 64002:64002`,
      `chmod /jail/x/root${CHROOT_VMCONFIG_PATH} 400`,
    ]);
  });
});

describe("removeJailDir / helpers", () => {
  it("reclaims the jail tree recursively", async () => {
    const { fs, ops } = fakeJailFs();
    await removeJailDir("/jail/firecracker/run-1-1", fs);
    expect(ops).toEqual(["rm /jail/firecracker/run-1-1 -r"]);
  });

  it("jailChrootBase is the runs dir's sibling (same filesystem as the artifacts)", () => {
    expect(jailChrootBase("/var/lib/appstrate-runner/runs")).toBe("/var/lib/appstrate-runner/jail");
  });

  it("fcExecName reduces bare names and paths alike to the basename", () => {
    expect(fcExecName("firecracker")).toBe("firecracker");
    expect(fcExecName("/usr/local/bin/firecracker")).toBe("firecracker");
  });

  it("chroot-relative constants match the jailer conventions", () => {
    expect(CHROOT_API_SOCKET_PATH).toBe("/run/firecracker.socket");
    expect(CHROOT_CONFIG_DRIVE_PATH).toBe("/config.img");
  });
});
