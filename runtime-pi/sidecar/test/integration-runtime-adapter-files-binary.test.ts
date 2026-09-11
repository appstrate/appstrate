// SPDX-License-Identifier: Apache-2.0

/**
 * R8a — binary credential support in `delivery.files`.
 *
 * The wire format on `IntegrationSpawnSpec.fileMounts[<path>].content_b64` is
 * always base64-encoded by the platform-side resolver (the field is `content_b64`
 * precisely so binary cert/key material survives the JSON envelope), so the
 * sidecar's two adapters decode it unconditionally. This test exercises a
 * non-UTF-8 byte sequence (`0x00…0xFF`) round-tripping through the process
 * adapter — same `Buffer.from(value, "base64")` path the docker adapter uses
 * after `docker cp`. The lossy `Buffer.from(value, "utf8")` mojibake regression
 * would surface here as a length mismatch or out-of-band byte at index 0/0xFF.
 *
 * Also covers the safe-path floor: even with valid base64, paths into
 * `/dev/*`, `/proc/*`, `/sys/*`, and `/etc/passwd*` are refused.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isHostPathSafeForMount,
  materializeFileMountsOnHost,
} from "../integration-runtime-adapter-process.ts";
import {
  isContainerPathSafeForMount,
  stageFileMountsOnHost,
} from "../integration-runtime-adapter-docker.ts";
import { normalizeMountPath } from "../integration-runtime-adapter.ts";

describe("delivery.files — binary content round-trip", () => {
  let scratchRoot: string;

  beforeEach(async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "appstrate-files-binary-test-"));
  });

  it("decodes 256-byte 0x00..0xff sequence losslessly via base64", async () => {
    const targetPath = join(scratchRoot, "binary-key.der");
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const content_b64 = Buffer.from(bytes).toString("base64");

    const { createdPaths } = await materializeFileMountsOnHost("run-bin", {
      [targetPath]: { content_b64, mode: "0400" },
    });

    expect(createdPaths).toContain(targetPath);

    const onDisk = await readFile(targetPath);
    expect(onDisk.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(onDisk[i]).toBe(i);
    }

    const st = await stat(targetPath);
    expect(st.mode & 0o777).toBe(0o400);
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("round-trips a real PKCS8 PEM through base64 + back without corruption", async () => {
    // Use a representative PEM-looking blob with mixed ASCII + Latin-1
    // bytes to mirror real key material. Length doesn't matter — what we
    // care about is byte-perfect equality.
    const pem = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDExample
-----END PRIVATE KEY-----
`;
    const bytes = new TextEncoder().encode(pem);
    const content_b64 = Buffer.from(bytes).toString("base64");

    const targetPath = join(scratchRoot, "client.key");
    const { createdPaths } = await materializeFileMountsOnHost("run-pem", {
      [targetPath]: { content_b64, mode: "0600" },
    });
    expect(createdPaths).toContain(targetPath);

    const onDisk = await readFile(targetPath, "utf8");
    expect(onDisk).toBe(pem);
    await rm(scratchRoot, { recursive: true, force: true });
  });
});

describe("delivery.files — safe-path floor (R8a)", () => {
  it("rejects host paths under /dev, /proc, /sys", () => {
    expect(isHostPathSafeForMount("/dev/null")).toBe(false);
    expect(isHostPathSafeForMount("/dev/tcp/127.0.0.1/8080")).toBe(false);
    expect(isHostPathSafeForMount("/proc/self/mem")).toBe(false);
    expect(isHostPathSafeForMount("/sys/kernel/debug/x")).toBe(false);
  });

  it("rejects /etc/passwd, /etc/shadow, /etc/sudoers families", () => {
    for (const p of [
      "/etc/passwd",
      "/etc/passwd-",
      "/etc/shadow",
      "/etc/shadow-",
      "/etc/sudoers",
      "/etc/sudoers.d/00-overrides",
      "/etc/group",
      "/etc/gshadow",
    ]) {
      expect(isHostPathSafeForMount(p)).toBe(false);
    }
  });

  // `/usr/` and `/workspace/` are NOT docker-private surfaces — they are
  // PATH-writable and workspace-collision surfaces, and both matter at least
  // as much on the process adapter, which has FEWER containment layers than
  // docker, is the Tier-0 default, and is what the Firecracker orchestrator
  // pins. A manifest declaring `delivery.files: { "/usr/local/bin/gh": … }`
  // was refused under docker and, under process, sent
  // `materializeFileMountsOnHost` through `mkdir -p /usr/local/bin` +
  // `writeFile` on the host / guest rootfs — planting an executable on PATH.
  it("rejects host paths under /usr and /workspace (PATH + workspace collision)", () => {
    expect(isHostPathSafeForMount("/usr/local/bin/gh")).toBe(false);
    expect(isHostPathSafeForMount("/usr/lib/x")).toBe(false);
    expect(isHostPathSafeForMount("/workspace/token.json")).toBe(false);
    expect(isHostPathSafeForMount("/workspace")).toBe(false);
    // Same verdict on the docker side — this floor is SHARED, not mirrored.
    expect(isContainerPathSafeForMount("/usr/local/bin/gh")).toBe(false);
    expect(isContainerPathSafeForMount("/workspace/token.json")).toBe(false);
  });

  it("materializeFileMountsOnHost skips a /usr/local/bin executable plant", async () => {
    // The gate is what stops the write, so exercise it through the writer and
    // not only through the predicate: nothing is created, nothing is surfaced
    // via the scratch-path fallback either.
    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-path-plant", {
      "/usr/local/bin/gh": {
        content_b64: Buffer.from("#!/bin/sh\n").toString("base64"),
        mode: "0755",
      },
    });
    expect(createdPaths).toEqual([]);
    expect(envOverrides).toEqual({});
  });

  it("accepts /run/, /tmp/, /etc/appstrate/, /var/* (manifest-friendly)", () => {
    expect(isHostPathSafeForMount("/run/creds/token")).toBe(true);
    expect(isHostPathSafeForMount("/tmp/cert.pem")).toBe(true);
    expect(isHostPathSafeForMount("/etc/appstrate/certs/client.pem")).toBe(true);
    expect(isHostPathSafeForMount("/var/lib/integration/foo.json")).toBe(true);
  });

  it("docker adapter mirrors the host adapter rejection list + adds /.docker/, /.dockerenv", () => {
    expect(isContainerPathSafeForMount("/dev/null")).toBe(false);
    expect(isContainerPathSafeForMount("/proc/1/root")).toBe(false);
    expect(isContainerPathSafeForMount("/sys/devices")).toBe(false);
    expect(isContainerPathSafeForMount("/etc/passwd")).toBe(false);
    expect(isContainerPathSafeForMount("/etc/sudoers.d/x")).toBe(false);
    expect(isContainerPathSafeForMount("/.docker/config.json")).toBe(false);
    expect(isContainerPathSafeForMount("/.dockerenv")).toBe(false);
    // Same valid paths the host adapter accepts.
    expect(isContainerPathSafeForMount("/run/creds/token")).toBe(true);
    expect(isContainerPathSafeForMount("/tmp/cert.pem")).toBe(true);
  });

  it("rejects relative paths and empty input", () => {
    expect(isHostPathSafeForMount("")).toBe(false);
    expect(isHostPathSafeForMount("relative/path")).toBe(false);
    expect(isContainerPathSafeForMount("")).toBe(false);
    expect(isContainerPathSafeForMount("relative/path")).toBe(false);
  });

  it("materializeFileMountsOnHost skips entries with unsafe paths (warns, doesn't throw)", async () => {
    // The process adapter logs + skips so a single bad entry doesn't
    // black-hole the entire fileMounts batch. The docker adapter takes
    // the throw route (different runtime contract); we cover that via
    // the unit-level `isContainerPathSafeForMount` checks above.
    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-skip", {
      "/dev/null": { content_b64: Buffer.from("x").toString("base64"), mode: "0400" },
    });
    expect(createdPaths).toEqual([]);
    expect(envOverrides).toEqual({});
  });
});

/**
 * The floor is a set of STRING comparisons and the kernel resolves PATHS.
 * `/./usr/local/bin/gh`, `//usr/local/bin/gh` and `/usr/./local/bin/gh` all
 * open `/usr/local/bin/gh`, and each one walked past a floor that knew only
 * the canonical spelling — one leading `/.` defeated it. The platform-side
 * resolver does not close it either: `isSafeDeliveryFilePath` rejects `..` and
 * keeps `.` and `//`.
 */
describe("delivery.files — safe-path floor judges the CANONICAL path", () => {
  /** Every alias here resolves to a path the floor refuses in canonical form. */
  const ALIASES_OF_REFUSED = [
    "/./usr/local/bin/gh",
    "//usr/local/bin/gh",
    "///usr/local/bin/gh",
    "/usr/./local/bin/gh",
    "/usr//local/bin/gh",
    "/a/../usr/local/bin/gh",
    "/./etc/passwd",
    "/etc//passwd",
    "/etc/./passwd",
    "/a/../etc/passwd",
    "/a/b/../../../etc/passwd",
    "/./dev/mem",
    "/dev/./mem",
    "/./proc/self/mem",
    "/etc/sudoers.d/./x",
    "/./workspace/token.json",
    "/workspace/./token.json",
    "/./bin/gh",
    "/./etc/ld.so.preload",
    "/./root/.ssh/authorized_keys",
  ];

  it("refuses every non-canonical spelling of a refused path, on BOTH adapters", () => {
    for (const alias of ALIASES_OF_REFUSED) {
      expect(isHostPathSafeForMount(alias)).toBe(false);
      expect(isContainerPathSafeForMount(alias)).toBe(false);
    }
  });

  it("refuses the spellings that collapse to bare root", () => {
    // `normalize` maps all of these onto `/`, which names no file to write.
    for (const rootish of ["/", "//", "/.", "/..", "/./", "/a/.."]) {
      expect(isHostPathSafeForMount(rootish)).toBe(false);
      expect(isContainerPathSafeForMount(rootish)).toBe(false);
    }
  });

  it("gives an alias exactly the verdict of the path it resolves to", () => {
    // The property behind the case above, stated once: a spelling cannot
    // change a verdict. Covers the allowed direction too, so the fix cannot
    // degenerate into "refuse anything with a dot in it".
    for (const raw of [
      ...ALIASES_OF_REFUSED,
      "/./run/creds/token",
      "/run//creds/token",
      "/etc/./appstrate/certs/client.pem",
      "/tmp/./cert.pem",
    ]) {
      expect(isHostPathSafeForMount(raw)).toBe(isHostPathSafeForMount(normalizeMountPath(raw)));
      expect(isContainerPathSafeForMount(raw)).toBe(
        isContainerPathSafeForMount(normalizeMountPath(raw)),
      );
    }
  });

  it("still accepts a legitimate destination written non-canonically", () => {
    expect(isHostPathSafeForMount("/./run/creds/token")).toBe(true);
    expect(isHostPathSafeForMount("/run//creds/token")).toBe(true);
    expect(isContainerPathSafeForMount("/etc/./appstrate/certs/client.pem")).toBe(true);
  });

  it("materializeFileMountsOnHost refuses the aliased PATH plant it used to write", async () => {
    // The predicate is not the thing that stops the write — the writer is.
    // Before the fix this pair (`mkdir -p` + `writeFile` on the RAW string)
    // landed a 0755 executable at `/usr/local/bin/gh`, because the kernel
    // resolved `/./usr/...` while the check compared strings.
    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-alias-plant", {
      "/./usr/local/bin/gh": {
        content_b64: Buffer.from("#!/bin/sh\n").toString("base64"),
        mode: "0755",
      },
      "//usr/local/bin/curl": {
        content_b64: Buffer.from("#!/bin/sh\n").toString("base64"),
        mode: "0755",
      },
    });
    expect(createdPaths).toEqual([]);
    expect(envOverrides).toEqual({});
  });

  it("materializeFileMountsOnHost writes an accepted mount at its CANONICAL path", async () => {
    // The other half of "the check and the write cannot disagree": what the
    // floor judged is what lands on disk, so a later reader of `createdPaths`
    // (shutdown's cleanup) is looking at the file that actually exists.
    const scratch = await mkdtemp(join(tmpdir(), "appstrate-files-canon-"));
    try {
      const declared = `${scratch}/./nested//creds/token`;
      const canonical = join(scratch, "nested/creds/token");
      const { createdPaths } = await materializeFileMountsOnHost("run-canon", {
        [declared]: { content_b64: Buffer.from("secret").toString("base64"), mode: "0400" },
      });
      expect(createdPaths).toEqual([canonical]);
      expect(await readFile(canonical, "utf8")).toBe("secret");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("stageFileMountsOnHost throws on an aliased path instead of staging it", async () => {
    // The docker adapter's `resolve()` ALWAYS normalized while its check did
    // not, so `/./usr/local/bin/gh` staged at `<root>/usr/local/bin/gh` and
    // `docker cp` put it on the container's PATH.
    await expect(
      stageFileMountsOnHost({
        "/./usr/local/bin/gh": {
          content_b64: Buffer.from("#!/bin/sh\n").toString("base64"),
          mode: "0755",
        },
      }),
    ).rejects.toThrow(/unsafe container path/);
  });

  it("stageFileMountsOnHost stages an accepted mount at its canonical mirror path", async () => {
    const root = await stageFileMountsOnHost({
      "/./run//creds/token": {
        content_b64: Buffer.from("secret").toString("base64"),
        mode: "0400",
      },
    });
    try {
      expect(await readFile(join(root, "run/creds/token"), "utf8")).toBe("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * `/usr/` was refused because it "plants an executable on the PATH of
 * everything that runs next" — and that rationale was applied to exactly one
 * of its instances. `/bin/gh` and `/sbin/x` are the REST of the same PATH in
 * the runner image (`oven/bun:1.3.14-alpine`); `/etc/ld.so.preload` is
 * strictly worse (it injects into every process spawned afterwards, whatever
 * its name); `/etc/profile.d/x.sh` is sourced by every login shell; and
 * `/root/.ssh/authorized_keys` hands out a login. All were ACCEPTED.
 *
 * The floor now states the rule instead of one of its instances: refuse
 * anywhere the system reads on its own initiative.
 */
describe("delivery.files — the auto-consumed floor covers the whole class", () => {
  const REFUSED = {
    "PATH entries beside /usr": ["/bin/gh", "/sbin/x", "/bin", "/usr/local/bin/gh"],
    "loader search dirs": ["/lib/x.so", "/lib64/x.so", "/libexec/x"],
    "loader config": ["/etc/ld.so.preload", "/etc/ld.so.conf", "/etc/ld.so.conf.d/x.conf"],
    "shell startup": [
      "/etc/profile",
      "/etc/profile.d/x.sh",
      "/etc/bash.bashrc",
      "/etc/environment",
      "/root/.bashrc",
      "/home/runner/.bashrc",
      "/home/runner/.zshrc",
    ],
    scheduler: ["/etc/crontab", "/etc/cron.d/x", "/etc/periodic/daily/x", "/var/spool/cron/runner"],
    "auth + login": [
      "/etc/pam.d/x",
      "/etc/ssh/sshd_config",
      "/root/.ssh/authorized_keys",
      "/home/runner/.ssh/authorized_keys",
      "/home/runner/.ssh/id_rsa",
      "/etc/passwd",
      "/etc/sudoers.d/x",
    ],
    "system trust store": ["/etc/ssl/certs/ca.pem", "/etc/ssl/cert.pem", "/etc/pki/tls/x.pem"],
  };

  for (const [surface, paths] of Object.entries(REFUSED)) {
    it(`refuses ${surface}, on BOTH adapters`, () => {
      for (const p of paths) {
        expect(isHostPathSafeForMount(p)).toBe(false);
        expect(isContainerPathSafeForMount(p)).toBe(false);
      }
    });
  }

  it("does NOT over-refuse: /etc/<vendor>/ stays a supported destination", () => {
    // The docker adapter's docstring names `/etc/<vendor>/` as where certs and
    // service-account JSON belong, which is why `/etc` is refused file-by-file
    // and subtree-by-subtree rather than wholesale. A floor that refused all
    // of `/etc/` would pass every case above and break the feature.
    for (const p of [
      "/etc/appstrate/certs/client.pem",
      "/etc/vendor/service-account.json",
      "/etc/myintegration/config.yaml",
      "/run/creds/token",
      "/tmp/cert.pem",
      "/var/tmp/cert.pem",
      "/var/lib/integration/foo.json",
    ]) {
      expect(isHostPathSafeForMount(p)).toBe(true);
      expect(isContainerPathSafeForMount(p)).toBe(true);
    }
  });

  it("materializeFileMountsOnHost skips a /bin plant and an ld.so.preload injection", async () => {
    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-class", {
      "/bin/gh": { content_b64: Buffer.from("#!/bin/sh\n").toString("base64"), mode: "0755" },
      "/etc/ld.so.preload": {
        content_b64: Buffer.from("/tmp/evil.so\n").toString("base64"),
        mode: "0644",
      },
      "/root/.ssh/authorized_keys": {
        content_b64: Buffer.from("ssh-ed25519 AAAA\n").toString("base64"),
        mode: "0600",
      },
    });
    expect(createdPaths).toEqual([]);
    expect(envOverrides).toEqual({});
  });
});
