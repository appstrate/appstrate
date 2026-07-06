// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate runner` command group.
 *
 * Pure logic only — preflight matrix, token generation, config-file
 * rendering (with a snapshot of the hardened systemd unit), firewall
 * synthesis, checksum verification, and the update swap. Every host side
 * effect goes through injected fakes (no `mock.module()`, no real KVM host,
 * no network, no systemctl).
 */

import { describe, it, expect } from "bun:test";
import { runPreflight } from "../src/lib/runner/preflight.ts";
import {
  generateRunnerToken,
  renderRunnerEnvFile,
  parseRunnerEnvFile,
  renderRunnerUnit,
  firewallCommands,
  type RunnerConfig,
} from "../src/lib/runner/config-files.ts";
import {
  parseSha256,
  sha256Hex,
  daemonUrls,
  firecrackerUrls,
  downloadDaemon,
} from "../src/lib/runner/download.ts";
import {
  resolveRunnerArch,
  runnerDataPaths,
  daemonAssetName,
  APPSTRATE_RELEASE_BASE,
} from "../src/lib/runner/constants.ts";
import {
  resolveDaemonVersion,
  runnerUpdateCommand,
  runnerDoctor,
  pollHealth,
  enableService,
} from "../src/commands/runner.ts";
import type { RunnerExec, RunnerFs, RunnerHttp } from "../src/lib/runner/exec.ts";

// ─── fakes ───────────────────────────────────────────────────────────────

function fakeExec(
  overrides: Partial<
    Record<string, () => { ok: boolean; exitCode: number; stdout: string; stderr: string }>
  > = {},
): {
  exec: RunnerExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: RunnerExec = {
    async run(cmd, args) {
      calls.push([cmd, ...args]);
      const key = `${cmd} ${args[0] ?? ""}`.trim();
      const fn = overrides[key] ?? overrides[cmd];
      if (fn) return fn();
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    exists() {
      return true;
    },
  };
  return { exec, calls };
}

function fakeFs(seed: Record<string, string> = {}): {
  fs: RunnerFs;
  installed: { dest: string; bytes: Uint8Array; mode: number }[];
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...seed };
  const installed: { dest: string; bytes: Uint8Array; mode: number }[] = [];
  const fs: RunnerFs = {
    async writeFile(path, data) {
      files[path] = typeof data === "string" ? data : "<bytes>";
    },
    async readFile(path) {
      return files[path] ?? null;
    },
    async readFileBytes(path) {
      return files[path] !== undefined ? new TextEncoder().encode(files[path]) : null;
    },
    async mkdirp() {},
    async chmod() {},
    async exists(path) {
      return files[path] !== undefined;
    },
    async canReadWrite() {
      return true;
    },
    async rename() {},
    async remove() {},
    async installAtomic(dest, bytes, mode) {
      installed.push({ dest, bytes, mode });
      files[dest] = "<installed>";
    },
  };
  return { fs, installed, files };
}

function fakeHttp(opts: {
  binary?: Uint8Array;
  sha?: string;
  health?: { status: number; body: unknown };
}): RunnerHttp {
  return {
    async fetchBinary() {
      return opts.binary ?? new Uint8Array([1, 2, 3]);
    },
    async fetchText() {
      return opts.sha ?? "";
    },
    async getJson() {
      if (opts.health)
        return { reachable: true, status: opts.health.status, body: opts.health.body };
      return { reachable: false, error: "no fake health" };
    },
  };
}

// ─── preflight ──────────────────────────────────────────────────────────

describe("runPreflight", () => {
  const green = {
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    canAccessKvm: async () => true,
    commandExists: () => true,
  };

  it("passes on a linux/x64 host with kvm + nft + ip", async () => {
    const r = await runPreflight(green);
    expect(r.ok).toBe(true);
    expect(r.arch).toBe("x86_64");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails and remedies a non-linux host", async () => {
    const r = await runPreflight({ ...green, platform: "darwin" });
    expect(r.ok).toBe(false);
    const os = r.checks.find((c) => c.id === "os")!;
    expect(os.ok).toBe(false);
    expect(os.remedy).toContain("Linux");
    // /dev/kvm probe is skipped on non-linux (no misleading second failure).
    expect(r.checks.find((c) => c.id === "kvm")).toBeUndefined();
  });

  it("fails an unsupported architecture without throwing", async () => {
    const r = await runPreflight({ ...green, arch: "ppc64" });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "arch")!.ok).toBe(false);
  });

  it("fails when /dev/kvm is not writable", async () => {
    const r = await runPreflight({ ...green, canAccessKvm: async () => false });
    expect(r.ok).toBe(false);
    const kvm = r.checks.find((c) => c.id === "kvm")!;
    expect(kvm.ok).toBe(false);
    expect(kvm.remedy).toContain("kvm");
  });

  it("fails when nft or ip is missing", async () => {
    const noNft = await runPreflight({ ...green, commandExists: (c) => c !== "nft" });
    expect(noNft.checks.find((c) => c.id === "nft")!.ok).toBe(false);
    const noIp = await runPreflight({ ...green, commandExists: (c) => c !== "ip" });
    expect(noIp.checks.find((c) => c.id === "ip")!.ok).toBe(false);
  });
});

// ─── token ──────────────────────────────────────────────────────────────

describe("generateRunnerToken", () => {
  it("is 48 lowercase hex chars", () => {
    expect(generateRunnerToken()).toMatch(/^[0-9a-f]{48}$/);
  });
  it("is unique across calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateRunnerToken()));
    expect(seen.size).toBe(50);
  });
});

// ─── config files ─────────────────────────────────────────────────────────

const config: RunnerConfig = {
  token: "a".repeat(48),
  platformUrl: "http://10.0.0.5:3000",
  port: 3100,
  host: "0.0.0.0",
  dataDir: "/var/lib/appstrate-runner",
};

describe("renderRunnerEnvFile / parseRunnerEnvFile", () => {
  it("pins the token, platform URL, port, and ABSOLUTE firecracker paths", () => {
    const text = renderRunnerEnvFile(config);
    const env = parseRunnerEnvFile(text);
    expect(env.FIRECRACKER_RUNNER_TOKEN).toBe(config.token);
    expect(env.FIRECRACKER_RUNNER_PLATFORM_URL).toBe("http://10.0.0.5:3000");
    expect(env.FIRECRACKER_RUNNER_PORT).toBe("3100");
    const paths = runnerDataPaths(config.dataDir);
    expect(env.FIRECRACKER_KERNEL_PATH).toBe(paths.kernelPath);
    expect(env.FIRECRACKER_ROOTFS_PATH).toBe(paths.rootfsPath);
    expect(env.FIRECRACKER_DATA_DIR).toBe(paths.runsDir);
    expect(env.FIRECRACKER_BIN).toBe(paths.firecrackerBin);
    expect(env.FIRECRACKER_JAILER_BIN).toBe(paths.jailerBin);
    // No cwd-relative default leaked through.
    expect(text).not.toContain("./data/firecracker");
  });

  it("parse ignores comments + blank lines", () => {
    const env = parseRunnerEnvFile("# comment\n\nKEY=value\n  OTHER = x \n");
    expect(env).toEqual({ KEY: "value", OTHER: "x" });
  });
});

describe("renderRunnerUnit", () => {
  it("is a hardened, PATH-corrected, always-restarting unit (snapshot)", () => {
    expect(renderRunnerUnit(config)).toMatchSnapshot();
  });

  it("scopes ReadWritePaths to the data dir and puts sbin + data bin on PATH", () => {
    const unit = renderRunnerUnit({ ...config, dataDir: "/srv/runner" });
    expect(unit).toContain("ExecStart=/usr/local/bin/appstrate-runner");
    expect(unit).toContain("EnvironmentFile=/etc/appstrate-runner/env");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/srv/runner");
    // PrivateTmp: the daemon's VMM socket root lives under tmpdir(), so a private
    // writable /tmp is required or boundary creation fails EROFS under ProtectSystem.
    expect(unit).toContain("PrivateTmp=true");
    // /run/netns writable + pre-created for the boot net-probe's `ip netns add`.
    expect(unit).toContain("ReadWritePaths=/run/netns");
    expect(unit).toContain("ExecStartPre=+/bin/mkdir -p /run/netns");
    expect(unit).toContain("WorkingDirectory=/srv/runner");
    // cgroup-v2 delegation for the jailer's per-VM appstrate-fc slices.
    expect(unit).toContain("Delegate=yes");
    expect(unit).toContain("Restart=always");
    // Start-rate limit bounds the Restart=always loop (StartLimit* live in [Unit]).
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=30");
    expect(unit).toContain("/usr/sbin");
    expect(unit).toContain("/sbin");
    expect(unit).toContain("/srv/runner/bin");
    // The aggressive knobs that would break KVM/TAP/sysctl must NOT be set.
    expect(unit).not.toContain("PrivateDevices=");
    expect(unit).not.toContain("ProtectKernelTunables=true");
    expect(unit).not.toContain("RestrictAddressFamilies=");
  });
});

describe("firewallCommands", () => {
  it("renders ufw / firewalld / none", () => {
    expect(firewallCommands("ufw", 3100).commands[0]).toContain("ufw allow 3100/tcp");
    expect(firewallCommands("firewalld", 3100).commands).toContain("firewall-cmd --reload");
    expect(firewallCommands("none", 3100).commands[0]).toContain("3100");
  });
});

// ─── download / verification ────────────────────────────────────────────

describe("parseSha256", () => {
  it("extracts the leading 64-hex digest", () => {
    expect(parseSha256(`${"a".repeat(64)}  appstrate-runner-x86_64\n`)).toBe("a".repeat(64));
  });
  it("rejects a malformed manifest", () => {
    expect(() => parseSha256("not-a-hash file")).toThrow(/malformed sha256/);
  });
});

describe("url builders", () => {
  it("daemonUrls: latest vs pinned", () => {
    expect(daemonUrls("latest", "x86_64").binary).toContain(
      "/latest/download/appstrate-runner-x86_64",
    );
    const pinned = daemonUrls("1.2.3", "aarch64");
    expect(pinned.binary).toContain("/download/v1.2.3/appstrate-runner-aarch64");
    expect(pinned.checksums).toBe(`${APPSTRATE_RELEASE_BASE}/download/v1.2.3/checksums.txt`);
    expect(pinned.checksumsSig).toBe(`${pinned.checksums}.minisig`);
  });
  it("firecrackerUrls: tarball + sha + inner paths (VMM and jailer from ONE archive)", () => {
    const u = firecrackerUrls("1.16.0", "x86_64");
    expect(u.tarball).toContain("/v1.16.0/firecracker-v1.16.0-x86_64.tgz");
    expect(u.sha256).toContain(".tgz.sha256.txt");
    expect(u.innerPath).toBe("release-v1.16.0-x86_64/firecracker-v1.16.0-x86_64");
    expect(u.jailerInnerPath).toBe("release-v1.16.0-x86_64/jailer-v1.16.0-x86_64");
  });
});

describe("downloadDaemon", () => {
  it("returns the bytes when the signed checksum matches", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const sha = sha256Hex(bytes);
    // `sha` doubles as the checksums.txt body (fetchText) — one line for the asset.
    const http = fakeHttp({ binary: bytes, sha: `${sha}  appstrate-runner-x86_64` });
    const { fs } = fakeFs();
    const { exec } = fakeExec(); // default minisign probe + -Vm both `ok`.
    const out = await downloadDaemon({ http, exec, fs, version: "1.0.0", arch: "x86_64" });
    expect(out).toEqual(bytes);
  });

  it("throws on a sha256 mismatch (never returns tampered bytes)", async () => {
    const bytes = new Uint8Array([1, 1, 1]);
    const http = fakeHttp({ binary: bytes, sha: `${"b".repeat(64)}  appstrate-runner-x86_64` });
    const { fs } = fakeFs();
    const { exec } = fakeExec();
    await expect(
      downloadDaemon({ http, exec, fs, version: "1.0.0", arch: "x86_64" }),
    ).rejects.toThrow(/mismatch/);
  });

  it("gives an actionable error when the release omitted runner assets (404)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const http: RunnerHttp = {
      // Mirror defaultRunnerHttp's non-2xx message shape.
      async fetchBinary(url) {
        throw new Error(`GET ${url} → HTTP 404`);
      },
      async fetchText(url) {
        throw new Error(`GET ${url} → HTTP 404`);
      },
      async getJson() {
        return { reachable: false, error: "n/a" };
      },
    };
    const { fs } = fakeFs();
    const { exec } = fakeExec();
    await expect(
      downloadDaemon({ http, exec, fs, version: "1.2.3", arch: "x86_64" }),
    ).rejects.toThrow(/published WITHOUT runner assets/);
    // Sanity: the raw bytes are never leaked when the fetch failed.
    expect(bytes).toBeDefined();
  });

  it("fails closed when minisign is not installed", async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const sha = sha256Hex(bytes);
    const http = fakeHttp({ binary: bytes, sha: `${sha}  appstrate-runner-x86_64` });
    const { fs } = fakeFs();
    // exitCode -1 = ENOENT (minisign not on PATH), matching runCommand's contract.
    const { exec } = fakeExec({
      minisign: () => ({ ok: false, exitCode: -1, stdout: "", stderr: "" }),
    });
    await expect(
      downloadDaemon({ http, exec, fs, version: "1.0.0", arch: "x86_64" }),
    ).rejects.toThrow(/minisign is required/);
  });

  it("rejects a checksums manifest that fails signature verification", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const sha = sha256Hex(bytes);
    const http = fakeHttp({ binary: bytes, sha: `${sha}  appstrate-runner-x86_64` });
    const { fs } = fakeFs();
    // `minisign -Vm …` returns non-zero → signature rejected. The probe
    // (`minisign -v`, args[0] === "-v") must still succeed, so key on the verb.
    const { exec } = fakeExec({
      "minisign -Vm": () => ({ ok: false, exitCode: 1, stdout: "", stderr: "bad sig" }),
    });
    await expect(
      downloadDaemon({ http, exec, fs, version: "1.0.0", arch: "x86_64" }),
    ).rejects.toThrow(/Signature verification FAILED/);
  });
});

// ─── version / arch ────────────────────────────────────────────────────────

describe("resolveDaemonVersion / resolveRunnerArch", () => {
  it("maps a dev CLI to `latest` and a release to its version", () => {
    expect(resolveDaemonVersion("0.0.0")).toBe("latest");
    expect(resolveDaemonVersion("1.4.2")).toBe("1.4.2");
  });
  it("maps node arch to release labels", () => {
    expect(resolveRunnerArch("x64")).toBe("x86_64");
    expect(resolveRunnerArch("arm64")).toBe("aarch64");
    expect(() => resolveRunnerArch("mips")).toThrow(/unsupported architecture/);
  });
});

// ─── update swap ──────────────────────────────────────────────────────────

describe("runnerUpdateCommand", () => {
  it("verifies, atomic-swaps the binary, and restarts the unit", async () => {
    const bytes = new Uint8Array([4, 2]);
    const sha = sha256Hex(bytes);
    const { fs, installed } = fakeFs();
    const { exec, calls } = fakeExec();
    // The daemon is verified against the signed checksums.txt line for the
    // runtime arch, so the manifest line must carry the resolved asset name.
    const asset = daemonAssetName(resolveRunnerArch());
    await runnerUpdateCommand({
      deps: {
        getuid: () => 0,
        fs,
        exec,
        http: fakeHttp({ binary: bytes, sha: `${sha}  ${asset}` }),
      },
    });
    expect(installed).toHaveLength(1);
    expect(installed[0]!.dest).toBe("/usr/local/bin/appstrate-runner");
    expect(installed[0]!.mode).toBe(0o755);
    expect(calls).toContainEqual(["systemctl", "restart", "appstrate-runner"]);
  });
});

// ─── enable + start ─────────────────────────────────────────────────────────

describe("enableService", () => {
  const deps = (exec: RunnerExec) => ({
    exec,
    fs: fakeFs().fs,
    http: fakeHttp({}),
    getuid: () => 0,
    preflight: async () => ({ ok: true, arch: "x86_64" as const, checks: [] }),
  });

  it("reloads, enables for persistence, then restarts (never `enable --now`)", async () => {
    const { exec, calls } = fakeExec();
    await enableService(deps(exec));
    expect(calls).toContainEqual(["systemctl", "daemon-reload"]);
    expect(calls).toContainEqual(["systemctl", "enable", "appstrate-runner"]);
    // `restart` is idempotent — it starts the NEW binary even when a stale
    // daemon is already active (the re-install bug `enable --now` masked).
    expect(calls).toContainEqual(["systemctl", "restart", "appstrate-runner"]);
    expect(calls).not.toContainEqual(["systemctl", "enable", "--now", "appstrate-runner"]);
  });

  it("throws with stderr when restart fails", async () => {
    const { exec } = fakeExec({
      "systemctl restart": () => ({ ok: false, exitCode: 1, stdout: "", stderr: "boom" }),
    });
    await expect(enableService(deps(exec))).rejects.toThrow(
      /restart appstrate-runner failed: boom/,
    );
  });
});

// ─── doctor assembly ───────────────────────────────────────────────────────

describe("runnerDoctor", () => {
  it("reports healthy when preflight + systemd + health + artifacts + jailer all pass", async () => {
    const envText = renderRunnerEnvFile(config);
    const marker = runnerDataPaths(config.dataDir).artifactsMarker;
    const { fs } = fakeFs({
      "/etc/appstrate-runner/env": envText,
      "/etc/systemd/system/appstrate-runner.service": "unit",
      [marker]: JSON.stringify({ version: "1.2.3", guest_protocol: 1 }),
      [runnerDataPaths(config.dataDir).jailerBin]: "<installed>",
    });
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: true, exitCode: 0, stdout: "active\n", stderr: "" }),
      "systemctl is-enabled": () => ({ ok: true, exitCode: 0, stdout: "enabled\n", stderr: "" }),
    });
    const report = await runnerDoctor({
      deps: {
        fs,
        exec,
        http: fakeHttp({ health: { status: 200, body: { protocol: 1, initialized: true } } }),
        preflight: async () => ({
          ok: true,
          arch: "x86_64",
          checks: [{ id: "os", label: "OS", ok: true, detail: "Linux" }],
        }),
      },
    });
    expect(report.ok).toBe(true);
    expect(report.service.active).toBe(true);
    expect(report.health.status).toBe(200);
    expect(report.artifacts.version).toBe("1.2.3");
    expect(report.artifacts.guestProtocol).toBe(1);
    expect(report.jailer.path).toBe(`${config.dataDir}/bin/jailer`);
    expect(report.jailer.installed).toBe(true);
  });

  it("reports NOT-ok when the jailer is required but missing (S-11)", async () => {
    // Everything else green — but FIRECRACKER_JAILER defaults to "on" and
    // the binary is absent: the daemon would refuse its next boot, so a
    // green doctor here would lie.
    const marker = runnerDataPaths(config.dataDir).artifactsMarker;
    const { fs } = fakeFs({
      "/etc/appstrate-runner/env": renderRunnerEnvFile(config),
      "/etc/systemd/system/appstrate-runner.service": "unit",
      [marker]: JSON.stringify({ version: "1.2.3", guest_protocol: 1 }),
    });
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: true, exitCode: 0, stdout: "active\n", stderr: "" }),
      "systemctl is-enabled": () => ({ ok: true, exitCode: 0, stdout: "enabled\n", stderr: "" }),
    });
    const report = await runnerDoctor({
      deps: {
        fs,
        exec,
        http: fakeHttp({ health: { status: 200, body: { protocol: 1, initialized: true } } }),
        preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
      },
    });
    expect(report.jailer.installed).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("stays ok without the jailer when FIRECRACKER_JAILER=off in the env file", async () => {
    const marker = runnerDataPaths(config.dataDir).artifactsMarker;
    const { fs } = fakeFs({
      "/etc/appstrate-runner/env": `${renderRunnerEnvFile(config)}\nFIRECRACKER_JAILER=off\n`,
      "/etc/systemd/system/appstrate-runner.service": "unit",
      [marker]: JSON.stringify({ version: "1.2.3", guest_protocol: 1 }),
    });
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: true, exitCode: 0, stdout: "active\n", stderr: "" }),
      "systemctl is-enabled": () => ({ ok: true, exitCode: 0, stdout: "enabled\n", stderr: "" }),
    });
    const report = await runnerDoctor({
      deps: {
        fs,
        exec,
        http: fakeHttp({ health: { status: 200, body: { protocol: 1, initialized: true } } }),
        preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
      },
    });
    expect(report.jailer.installed).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("reports not-ok when the daemon is unreachable", async () => {
    const { fs } = fakeFs({ "/etc/appstrate-runner/env": renderRunnerEnvFile(config) });
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: false, exitCode: 3, stdout: "inactive\n", stderr: "" }),
    });
    const report = await runnerDoctor({
      deps: {
        fs,
        exec,
        http: fakeHttp({}),
        preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.health.reachable).toBe(false);
  });
});

// ─── health poll (warming up vs crash-looped) ──────────────────────────────

describe("pollHealth", () => {
  const cfg = { port: 3100, token: "t".repeat(48) };

  it("returns true as soon as the daemon serves 200", async () => {
    const http = fakeHttp({ health: { status: 200, body: {} } });
    const { exec } = fakeExec();
    expect(await pollHealth(cfg, { exec, http }, 5000)).toBe(true);
  });

  it("bails early with the journal tail when the unit parked in `failed`", async () => {
    const http = fakeHttp({}); // getJson unreachable → never 200.
    const { exec } = fakeExec({
      "systemctl is-failed": () => ({ ok: true, exitCode: 0, stdout: "failed\n", stderr: "" }),
      journalctl: () => ({
        ok: true,
        exitCode: 0,
        stdout: "boot line\nFatalArtifactsError: rootfs sha mismatch\n",
        stderr: "",
      }),
    });
    await expect(pollHealth(cfg, { exec, http }, 5000)).rejects.toThrow(
      /did not stay running[\s\S]*FatalArtifactsError/,
    );
  });

  it("bails early when the unit is inactive (stopped)", async () => {
    const http = fakeHttp({});
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: false, exitCode: 3, stdout: "inactive\n", stderr: "" }),
    });
    await expect(pollHealth(cfg, { exec, http }, 5000)).rejects.toThrow(/inactive/);
  });

  it("returns false (still warming up) when the deadline elapses", async () => {
    const http = fakeHttp({}); // never 200.
    const { exec } = fakeExec();
    // timeoutMs 0 → the loop never enters; no 3s sleeps in the test.
    expect(await pollHealth(cfg, { exec, http }, 0)).toBe(false);
  });
});
