// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's engine config schema (runner/host-env.ts) —
 * currently the HTTPS trust-anchor enforcement on the artifacts base URL.
 * The manifest is the sole source of the vmlinux/rootfs checksums, so a
 * plaintext base URL would let a network attacker swap manifest + artifacts
 * consistently; https is required except for a same-host dev mirror.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { getFirecrackerEnv, _resetFirecrackerEnvCacheForTesting } from "../../runner/host-env.ts";

const KEY = "FIRECRACKER_ARTIFACTS_BASE_URL";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  _resetFirecrackerEnvCacheForTesting();
});

function parseWith(value: string): ReturnType<typeof getFirecrackerEnv> {
  process.env[KEY] = value;
  _resetFirecrackerEnvCacheForTesting();
  return getFirecrackerEnv();
}

describe("FIRECRACKER_ARTIFACTS_BASE_URL https enforcement", () => {
  it("accepts an https base URL", () => {
    expect(parseWith("https://mirror.example/releases").FIRECRACKER_ARTIFACTS_BASE_URL).toBe(
      "https://mirror.example/releases",
    );
  });

  it("rejects a plaintext http base URL to a remote host", () => {
    process.env[KEY] = "http://mirror.example/releases";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow(/https/);
  });

  it("allows http only for localhost / 127.0.0.1 (dev / same-host mirror)", () => {
    for (const u of ["http://localhost:8080/r", "http://127.0.0.1/r"]) {
      expect(parseWith(u).FIRECRACKER_ARTIFACTS_BASE_URL).toBe(u);
    }
  });

  it("does not require the variable — it stays optional (default GH Releases)", () => {
    delete process.env[KEY];
    _resetFirecrackerEnvCacheForTesting();
    expect(getFirecrackerEnv().FIRECRACKER_ARTIFACTS_BASE_URL).toBeUndefined();
  });
});
