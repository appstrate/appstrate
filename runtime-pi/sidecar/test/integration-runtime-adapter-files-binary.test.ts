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
import { isContainerPathSafeForMount } from "../integration-runtime-adapter-docker.ts";

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
