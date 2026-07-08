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
  withArtifactsVersionPin,
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
  RUNNER_ENV_PATH,
  RUNNER_BIN_PATH,
  RUNNER_UNIT_PATH,
  RUNNER_ETC_DIR,
  RUNNER_DATA_DIR,
  RUNNER_DEFAULT_SOCKET_PATH,
  APPSTRATE_RELEASE_BASE,
} from "../src/lib/runner/constants.ts";
import {
  resolveDaemonVersion,
  resolveInstallConfig,
  runnerUpdateCommand,
  runnerUninstallCommand,
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
  removed: string[];
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...seed };
  const installed: { dest: string; bytes: Uint8Array; mode: number }[] = [];
  const removed: string[] = [];
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
    async remove(path) {
      removed.push(path);
      delete files[path];
    },
    async installAtomic(dest, bytes, mode) {
      installed.push({ dest, bytes, mode });
      files[dest] = "<installed>";
    },
    async promoteFile(staged, dest, mode) {
      // The streamed daemon binary is promoted here (not installAtomic); record
      // it into the same `installed` list so existing assertions still hold.
      installed.push({ dest, bytes: new Uint8Array(), mode });
      files[dest] = "<installed>";
      delete files[staged];
    },
  };
  return { fs, installed, removed, files };
}

function fakeHttp(opts: {
  binary?: Uint8Array;
  sha?: string;
  health?: { status: number; body: unknown };
}): RunnerHttp {
  const binary = opts.binary ?? new Uint8Array([1, 2, 3]);
  return {
    async fetchToFile(_url, _dest, onProgress) {
      // The daemon binary streams through here; return its on-the-fly digest so
      // downloadDaemon can compare it to the signed checksums line.
      onProgress?.({ received: binary.byteLength, total: binary.byteLength, rateBytesPerSec: 1 });
      return { sha256: sha256Hex(binary) };
    },
    async fetchBinary() {
      return binary;
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

/** Default install path passed to downloadDaemon in the unit tests. */
const TEST_DAEMON_DEST = "/usr/local/bin/appstrate-runner";

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

// ─── install config: --platform-url validation ────────────────────────────

describe("resolveInstallConfig — --platform-url validation", () => {
  // Only fs is exercised (for token preservation); the URL check runs first,
  // so invalid URLs throw before any dep is touched.
  const deps = () =>
    ({
      exec: fakeExec().exec,
      fs: fakeFs().fs,
      http: fakeHttp({}),
      getuid: () => 0,
      preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
    }) as unknown as Parameters<typeof resolveInstallConfig>[1];

  it("accepts a valid IPv4 --platform-url and normalizes it", async () => {
    const { config } = await resolveInstallConfig(
      { platformUrl: "http://10.0.0.5:3100/", token: "x".repeat(16), yes: true },
      deps(),
    );
    expect(config.platformUrl).toBe("http://10.0.0.5:3100");
  });

  it("rejects out-of-range octets (shared IPv4 validator, like the daemon)", async () => {
    // The old `IPV4_URL_RE` regex accepted these dotted-quad-shaped hosts,
    // so the daemon then refused the config at boot. parseIpv4HttpUrl closes
    // the gap — same accept/reject rules as install --runner-url.
    for (const platformUrl of ["http://999.0.0.1", "http://256.256.256.256:3000"]) {
      await expect(
        resolveInstallConfig({ platformUrl, token: "x".repeat(16), yes: true }, deps()),
      ).rejects.toThrow(/must be http\(s\):\/\/<IPv4>/);
    }
  });

  it("rejects a non-IPv4 host --platform-url", async () => {
    await expect(
      resolveInstallConfig(
        { platformUrl: "http://platform.local:3000", token: "x".repeat(16), yes: true },
        deps(),
      ),
    ).rejects.toThrow(/must be http\(s\):\/\/<IPv4>/);
  });
});

// ─── install config: --socket (UDS transport) ─────────────────────────────

describe("resolveInstallConfig — --socket (UDS transport)", () => {
  const deps = () =>
    ({
      exec: fakeExec().exec,
      fs: fakeFs().fs,
      http: fakeHttp({}),
      getuid: () => 0,
      preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
    }) as unknown as Parameters<typeof resolveInstallConfig>[1];
  const base = { platformUrl: "http://10.0.0.5:3000", token: "x".repeat(16), yes: true };

  it("accepts an absolute --socket and records it as the transport", async () => {
    const { config } = await resolveInstallConfig(
      { ...base, socket: RUNNER_DEFAULT_SOCKET_PATH },
      deps(),
    );
    expect(config.socketPath).toBe(RUNNER_DEFAULT_SOCKET_PATH);
  });

  it("errors loudly when --socket is combined with --port (mutually exclusive)", async () => {
    await expect(
      resolveInstallConfig({ ...base, socket: RUNNER_DEFAULT_SOCKET_PATH, port: "3200" }, deps()),
    ).rejects.toThrow(/--socket is mutually exclusive with --port\/--host/);
  });

  it("errors loudly when --socket is combined with --host (mutually exclusive)", async () => {
    await expect(
      resolveInstallConfig(
        { ...base, socket: RUNNER_DEFAULT_SOCKET_PATH, host: "10.0.0.5" },
        deps(),
      ),
    ).rejects.toThrow(/--socket is mutually exclusive with --port\/--host/);
  });

  it("rejects a relative or empty --socket with an actionable message", async () => {
    for (const socket of ["runner.sock", "./runner.sock", "", "   "]) {
      await expect(resolveInstallConfig({ ...base, socket }, deps())).rejects.toThrow(
        /must be an absolute path/,
      );
    }
  });

  it("non-interactive without --socket stays TCP (backward compatible)", async () => {
    const { config } = await resolveInstallConfig(base, deps());
    expect(config.socketPath).toBeUndefined();
    expect(config.port).toBe(3100);
    expect(config.host).toBe("0.0.0.0");
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

  it("omits the artifacts-version pin for a dev (latest) install", () => {
    const env = parseRunnerEnvFile(renderRunnerEnvFile(config));
    expect(env.FIRECRACKER_ARTIFACTS_VERSION).toBeUndefined();
  });

  it("pins the artifacts version to the daemon release when set", () => {
    const env = parseRunnerEnvFile(renderRunnerEnvFile({ ...config, artifactsVersion: "1.2.3" }));
    expect(env.FIRECRACKER_ARTIFACTS_VERSION).toBe("1.2.3");
  });

  it("UDS transport: renders FIRECRACKER_RUNNER_SOCKET and drops the HOST/PORT lines", () => {
    const text = renderRunnerEnvFile({ ...config, socketPath: RUNNER_DEFAULT_SOCKET_PATH });
    const env = parseRunnerEnvFile(text);
    expect(env.FIRECRACKER_RUNNER_SOCKET).toBe(RUNNER_DEFAULT_SOCKET_PATH);
    // The socket REPLACES the TCP listen surface — no dual-listener ambiguity.
    expect(text).not.toContain("FIRECRACKER_RUNNER_HOST=");
    expect(text).not.toContain("FIRECRACKER_RUNNER_PORT=");
    // Everything else is identical to a TCP render.
    expect(env.FIRECRACKER_RUNNER_TOKEN).toBe(config.token);
    expect(env.FIRECRACKER_RUNNER_PLATFORM_URL).toBe(config.platformUrl);
    expect(env.FIRECRACKER_KERNEL_PATH).toBe(runnerDataPaths(config.dataDir).kernelPath);
  });

  it("rejects a newline-injected socketPath (env-file line smuggling)", () => {
    expect(() =>
      renderRunnerEnvFile({ ...config, socketPath: "/run/x.sock\nFIRECRACKER_ARTIFACTS_LOCAL=1" }),
    ).toThrow(/must not contain a newline/);
  });
});

describe("withArtifactsVersionPin", () => {
  it("upserts the pin in place, preserving every other line", () => {
    const original = renderRunnerEnvFile({ ...config, artifactsVersion: "1.0.0" });
    const patched = withArtifactsVersionPin(original, "2.0.0");
    const env = parseRunnerEnvFile(patched);
    expect(env.FIRECRACKER_ARTIFACTS_VERSION).toBe("2.0.0");
    // Untouched keys survive the surgical patch.
    expect(env.FIRECRACKER_RUNNER_TOKEN).toBe(config.token);
    expect(env.FIRECRACKER_KERNEL_PATH).toBe(runnerDataPaths(config.dataDir).kernelPath);
    // No duplicate pin line.
    expect(patched.match(/FIRECRACKER_ARTIFACTS_VERSION=/g)).toHaveLength(1);
  });

  it("appends the pin when absent, keeping operator customizations", () => {
    const base = `${renderRunnerEnvFile(config)}FIRECRACKER_MAX_CONCURRENT_VMS=32\n`;
    const patched = withArtifactsVersionPin(base, "3.1.4");
    const env = parseRunnerEnvFile(patched);
    expect(env.FIRECRACKER_ARTIFACTS_VERSION).toBe("3.1.4");
    expect(env.FIRECRACKER_MAX_CONCURRENT_VMS).toBe("32");
  });

  it("strips the pin for a dev (latest) update", () => {
    const original = renderRunnerEnvFile({ ...config, artifactsVersion: "1.0.0" });
    const env = parseRunnerEnvFile(withArtifactsVersionPin(original, undefined));
    expect(env.FIRECRACKER_ARTIFACTS_VERSION).toBeUndefined();
    // Other keys remain.
    expect(env.FIRECRACKER_RUNNER_PORT).toBe("3100");
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
    // TCP install: no UDS-only directives leak into the unit.
    expect(unit).not.toContain("RuntimeDirectory=");
  });

  it("UDS at the canonical /run location: systemd owns the socket dir (RuntimeDirectory)", () => {
    const unit = renderRunnerUnit({ ...config, socketPath: RUNNER_DEFAULT_SOCKET_PATH });
    // ProtectSystem=strict makes /run read-only — RuntimeDirectory is what
    // lets the daemon bind its socket there (created 0770). Preserve=yes is
    // load-bearing: the platform container bind-mounts the dir, and a
    // remove+recreate on daemon restart would strand the container on the
    // orphaned directory inode (new socket invisible until container restart).
    expect(unit).toContain("RuntimeDirectory=appstrate-runner");
    expect(unit).toContain("RuntimeDirectoryMode=0770");
    expect(unit).toContain("RuntimeDirectoryPreserve=yes");
    expect(unit).not.toContain("ReadWritePaths=/run/appstrate-runner");
    // The rest of the hardening posture is untouched.
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain(`ReadWritePaths=${config.dataDir}`);
  });

  it("UDS at a custom parent dir: carves it writable via ReadWritePaths instead", () => {
    const unit = renderRunnerUnit({ ...config, socketPath: "/srv/sockets/runner.sock" });
    expect(unit).toContain("ReadWritePaths=/srv/sockets");
    expect(unit).not.toContain("RuntimeDirectory=");
    expect(unit).not.toContain("RuntimeDirectoryMode=");
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
  it("returns a staged path next to dest when the signed checksum matches", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const sha = sha256Hex(bytes);
    // `sha` doubles as the checksums.txt body (fetchText) — one line for the asset.
    const http = fakeHttp({ binary: bytes, sha: `${sha}  appstrate-runner-x86_64` });
    const { fs } = fakeFs();
    const { exec } = fakeExec(); // default minisign probe + -Vm both `ok`.
    const out = await downloadDaemon({
      http,
      exec,
      fs,
      version: "1.0.0",
      arch: "x86_64",
      destPath: TEST_DAEMON_DEST,
    });
    // Staged next to the destination (same dir → atomic promote).
    expect(out.stagedPath.startsWith("/usr/local/bin/")).toBe(true);
    expect(out.stagedPath).toContain("appstrate-runner-x86_64");
  });

  it("throws on a sha256 mismatch and removes the staged file", async () => {
    const bytes = new Uint8Array([1, 1, 1]);
    const http = fakeHttp({ binary: bytes, sha: `${"b".repeat(64)}  appstrate-runner-x86_64` });
    const { fs, removed } = fakeFs();
    const { exec } = fakeExec();
    await expect(
      downloadDaemon({
        http,
        exec,
        fs,
        version: "1.0.0",
        arch: "x86_64",
        destPath: TEST_DAEMON_DEST,
      }),
    ).rejects.toThrow(/mismatch/);
    // The unverified staged download must be cleaned up, never left on disk.
    expect(removed.some((p) => p.includes("appstrate-runner-x86_64"))).toBe(true);
  });

  it("gives an actionable error when the release omitted runner assets (404)", async () => {
    const http: RunnerHttp = {
      // Mirror defaultRunnerHttp's non-2xx message shape (now on fetchToFile).
      async fetchToFile(url) {
        throw new Error(`GET ${url} → HTTP 404`);
      },
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
      downloadDaemon({
        http,
        exec,
        fs,
        version: "1.2.3",
        arch: "x86_64",
        destPath: TEST_DAEMON_DEST,
      }),
    ).rejects.toThrow(/published WITHOUT runner assets/);
  });

  it("does not stream the daemon binary when the signed manifest fetch fails", async () => {
    let fetchToFileCalled = false;
    const http: RunnerHttp = {
      async fetchToFile() {
        fetchToFileCalled = true;
        return { sha256: "unused" };
      },
      async fetchBinary(url) {
        throw new Error(`GET ${url} → HTTP 500`);
      },
      async fetchText(url) {
        throw new Error(`GET ${url} → HTTP 500`);
      },
      async getJson() {
        return { reachable: false, error: "n/a" };
      },
    };
    const { fs, removed } = fakeFs();
    const { exec } = fakeExec();
    await expect(
      downloadDaemon({
        http,
        exec,
        fs,
        version: "1.0.0",
        arch: "x86_64",
        destPath: TEST_DAEMON_DEST,
      }),
    ).rejects.toThrow();
    // The manifest is fetched first; its failure aborts before the ~70 MB
    // stream ever starts, so nothing is staged and nothing needs cleanup.
    expect(fetchToFileCalled).toBe(false);
    expect(removed).toEqual([]);
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
      downloadDaemon({
        http,
        exec,
        fs,
        version: "1.0.0",
        arch: "x86_64",
        destPath: TEST_DAEMON_DEST,
      }),
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
      downloadDaemon({
        http,
        exec,
        fs,
        version: "1.0.0",
        arch: "x86_64",
        destPath: TEST_DAEMON_DEST,
      }),
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

  it("re-pins the artifacts version off the old release so the new daemon can boot", async () => {
    const bytes = new Uint8Array([4, 2]);
    const sha = sha256Hex(bytes);
    // A prior install pinned an OLD artifact release; the new daemon must not be
    // left pointing at it (a guest-protocol bump would fatally reject it).
    const { fs, files } = fakeFs({
      [RUNNER_ENV_PATH]: renderRunnerEnvFile({ ...config, artifactsVersion: "0.0.1-old" }),
    });
    const { exec } = fakeExec();
    const asset = daemonAssetName(resolveRunnerArch());
    await runnerUpdateCommand({
      deps: {
        getuid: () => 0,
        fs,
        exec,
        http: fakeHttp({ binary: bytes, sha: `${sha}  ${asset}` }),
      },
    });
    // The stale pin is gone (replaced with the new daemon version, or stripped
    // for a dev "latest" update) and the bearer token is untouched.
    expect(files[RUNNER_ENV_PATH]).not.toContain("0.0.1-old");
    expect(parseRunnerEnvFile(files[RUNNER_ENV_PATH]!).FIRECRACKER_RUNNER_TOKEN).toBe(config.token);
  });
});

// ─── enable + start ─────────────────────────────────────────────────────────

describe("enableService", () => {
  const deps = (exec: RunnerExec) => ({
    exec,
    fs: fakeFs().fs,
    http: fakeHttp({}),
    unixGetJson: async () => ({ reachable: false as const, error: "no fake socket" }),
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

  it("UDS install: probes /v1/health through the socket and reports it as the endpoint", async () => {
    const udsConfig: RunnerConfig = { ...config, socketPath: RUNNER_DEFAULT_SOCKET_PATH };
    const marker = runnerDataPaths(config.dataDir).artifactsMarker;
    const { fs } = fakeFs({
      "/etc/appstrate-runner/env": renderRunnerEnvFile(udsConfig),
      "/etc/systemd/system/appstrate-runner.service": "unit",
      [marker]: JSON.stringify({ version: "1.2.3", guest_protocol: 1 }),
      [runnerDataPaths(config.dataDir).jailerBin]: "<installed>",
    });
    const { exec } = fakeExec({
      "systemctl is-active": () => ({ ok: true, exitCode: 0, stdout: "active\n", stderr: "" }),
      "systemctl is-enabled": () => ({ ok: true, exitCode: 0, stdout: "enabled\n", stderr: "" }),
    });
    let tcpProbed = false;
    const unixCalls: Array<{ socketPath: string; path: string; token: string }> = [];
    const report = await runnerDoctor({
      deps: {
        fs,
        exec,
        http: {
          ...fakeHttp({}),
          async getJson() {
            tcpProbed = true;
            return { reachable: false, error: "should not be dialed" };
          },
        },
        unixGetJson: async (socketPath, path, token) => {
          unixCalls.push({ socketPath, path, token });
          return { reachable: true, status: 200, body: { protocol: 1, initialized: true } };
        },
        preflight: async () => ({ ok: true, arch: "x86_64", checks: [] }),
      },
    });
    expect(tcpProbed).toBe(false);
    expect(unixCalls).toEqual([
      { socketPath: RUNNER_DEFAULT_SOCKET_PATH, path: "/v1/health", token: config.token },
    ]);
    expect(report.ok).toBe(true);
    expect(report.health.status).toBe(200);
    // The report shows the socket path where a TCP install shows host:port.
    expect(report.health.endpoint).toBe(RUNNER_DEFAULT_SOCKET_PATH);
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

  it("UDS install: probes through the unix socket, never the TCP seam", async () => {
    const unixCalls: Array<{ socketPath: string; path: string; token: string }> = [];
    let tcpProbed = false;
    const http: RunnerHttp = {
      ...fakeHttp({}),
      async getJson() {
        tcpProbed = true;
        return { reachable: false, error: "should not be dialed" };
      },
    };
    const { exec } = fakeExec();
    const ok = await pollHealth(
      { ...cfg, socketPath: RUNNER_DEFAULT_SOCKET_PATH },
      {
        exec,
        http,
        unixGetJson: async (socketPath, path, token) => {
          unixCalls.push({ socketPath, path, token });
          return { reachable: true, status: 200, body: {} };
        },
      },
      5000,
    );
    expect(ok).toBe(true);
    expect(tcpProbed).toBe(false);
    expect(unixCalls).toEqual([
      { socketPath: RUNNER_DEFAULT_SOCKET_PATH, path: "/v1/health", token: cfg.token },
    ]);
  });
});

// ─── uninstall ──────────────────────────────────────────────────────────────

describe("runnerUninstallCommand", () => {
  it("stops+disables the unit and removes binary, unit, drop-in, config, and data (--yes)", async () => {
    const { fs, removed } = fakeFs();
    const { exec, calls } = fakeExec();
    await runnerUninstallCommand({ yes: true, deps: { getuid: () => 0, fs, exec } });

    // systemctl lifecycle: stop → disable → daemon-reload → reset-failed.
    expect(calls).toContainEqual(["systemctl", "stop", "appstrate-runner"]);
    expect(calls).toContainEqual(["systemctl", "disable", "appstrate-runner"]);
    expect(calls).toContainEqual(["systemctl", "daemon-reload"]);
    expect(calls).toContainEqual(["systemctl", "reset-failed", "appstrate-runner"]);

    // Every install artefact is removed, including the drop-in dir and the
    // default state root.
    expect(removed).toContain(RUNNER_UNIT_PATH);
    expect(removed).toContain(`${RUNNER_UNIT_PATH}.d`);
    expect(removed).toContain(RUNNER_BIN_PATH);
    expect(removed).toContain(RUNNER_ETC_DIR);
    expect(removed).toContain(RUNNER_DATA_DIR);
  });

  it("preserves the state dir with --keep-data", async () => {
    const { fs, removed } = fakeFs();
    const { exec } = fakeExec();
    await runnerUninstallCommand({
      yes: true,
      keepData: true,
      deps: { getuid: () => 0, fs, exec },
    });

    expect(removed).toContain(RUNNER_BIN_PATH);
    expect(removed).toContain(RUNNER_ETC_DIR);
    // The state root (kernel/rootfs/runs) is intentionally kept.
    expect(removed).not.toContain(RUNNER_DATA_DIR);
  });

  it("recovers a non-default data dir from the env file (FIRECRACKER_KERNEL_PATH)", async () => {
    const { fs, removed } = fakeFs({
      [RUNNER_ENV_PATH]: "FIRECRACKER_KERNEL_PATH=/srv/runner/vmlinux\n",
    });
    const { exec } = fakeExec();
    await runnerUninstallCommand({ yes: true, deps: { getuid: () => 0, fs, exec } });

    expect(removed).toContain("/srv/runner");
    expect(removed).not.toContain(RUNNER_DATA_DIR);
  });

  it("is idempotent — removing an absent install never throws", async () => {
    const { fs, removed } = fakeFs(); // empty: nothing on disk
    const { exec } = fakeExec();
    await runnerUninstallCommand({ yes: true, deps: { getuid: () => 0, fs, exec } });
    // Still targets the canonical paths (remove is rm -rf → no-op on missing).
    expect(removed).toContain(RUNNER_BIN_PATH);
  });
});
