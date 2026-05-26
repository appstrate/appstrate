// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — `delivery.files` materialisation (AFPS 2.0.2 §7.6, CC-5).
 *
 * The process adapter shares the host filesystem with the integration
 * subprocess, so we try to write each manifest-declared file at its absolute
 * path. When that fails (no permission in dev / test sandbox), we fall back
 * to a per-run scratch dir under `os.tmpdir()` and surface the resolved path
 * via an `APPSTRATE_FILE_MOUNT_*` env var.
 *
 * Runs fully in-process — no Docker.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeFileMountsOnHost } from "../integration-runtime-adapter-process.ts";

describe("materializeFileMountsOnHost (process adapter, CC-5)", () => {
  let scratchRoot: string;

  beforeEach(async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "appstrate-files-test-"));
  });

  it("writes files to the manifest-declared path when the parent is writable", async () => {
    const targetPath = join(scratchRoot, "creds", "client.pem");
    const certBody = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
    const content_b64 = Buffer.from(certBody, "utf8").toString("base64");

    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-abc", {
      [targetPath]: { content_b64, mode: "0600" },
    });

    expect(createdPaths).toContain(targetPath);
    expect(envOverrides).toEqual({});

    const onDisk = await readFile(targetPath, "utf8");
    expect(onDisk).toBe(certBody);

    const st = await stat(targetPath);
    // Lower 9 bits = mode bits. 0o600 = 0o600.
    expect(st.mode & 0o777).toBe(0o600);
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("falls back to a scratch path + env override when the manifest path is not writable", async () => {
    // `/run/creds/...` is not writable under normal user perms — exercises
    // the catch-and-fallback branch.
    const manifestPath = "/run/creds/test-fallback.pem";
    const body = "fallback-body";
    const content_b64 = Buffer.from(body, "utf8").toString("base64");

    const { createdPaths, envOverrides } = await materializeFileMountsOnHost("run-xyz", {
      [manifestPath]: { content_b64, mode: "0400" },
    });

    // Either we wrote at the manifest path (running as root in CI, say) or we
    // fell back. Both are valid; assert at least one of the two happened.
    const fellBack = Object.keys(envOverrides).length > 0;
    if (fellBack) {
      expect(createdPaths.length).toBe(1);
      const envKey = Object.keys(envOverrides)[0]!;
      expect(envKey).toMatch(/^APPSTRATE_FILE_MOUNT_/);
      const scratchPath = envOverrides[envKey]!;
      expect(scratchPath).toContain("appstrate-mounts-run-xyz");
      const onDisk = await readFile(scratchPath, "utf8");
      expect(onDisk).toBe(body);
      // Cleanup scratch fallback.
      await rm(join(tmpdir(), "appstrate-mounts-run-xyz"), {
        recursive: true,
        force: true,
      });
    } else {
      // Wrote at manifest path — verify and clean up.
      expect(createdPaths).toContain(manifestPath);
      const onDisk = await readFile(manifestPath, "utf8");
      expect(onDisk).toBe(body);
      await rm(manifestPath, { force: true });
    }
  });

  it("decodes base64 bytes losslessly for binary content", async () => {
    const targetPath = join(scratchRoot, "binary.bin");
    // Deliberately non-UTF-8 bytes (0x00-0xff round-trip).
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const content_b64 = Buffer.from(bytes).toString("base64");

    const { createdPaths } = await materializeFileMountsOnHost("run-bin", {
      [targetPath]: { content_b64, mode: "0400" },
    });
    expect(createdPaths).toContain(targetPath);

    const onDisk = await readFile(targetPath);
    expect(onDisk.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(onDisk[i]).toBe(i);
    await rm(scratchRoot, { recursive: true, force: true });
  });
});
