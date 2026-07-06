// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the daemon's engine config schema (runner/host-env.ts):
 * the HTTPS trust-anchor enforcement on the artifacts base URL (the
 * manifest is the sole source of the vmlinux/rootfs checksums, so a
 * plaintext base URL would let a network attacker swap manifest +
 * artifacts consistently; https is required except for a same-host dev
 * mirror) and the jailer confinement surface (FIRECRACKER_JAILER*,
 * FIRECRACKER_JAIL_*).
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

describe("jailer confinement surface (FIRECRACKER_JAILER* / FIRECRACKER_JAIL_*)", () => {
  const JAIL_KEYS = [
    "FIRECRACKER_JAILER",
    "FIRECRACKER_JAILER_BIN",
    "FIRECRACKER_JAIL_UID_BASE",
    "FIRECRACKER_JAIL_CGROUPS",
  ] as const;
  const saved = Object.fromEntries(JAIL_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of JAIL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetFirecrackerEnvCacheForTesting();
  });

  function freshEnv(): ReturnType<typeof getFirecrackerEnv> {
    _resetFirecrackerEnvCacheForTesting();
    return getFirecrackerEnv();
  }

  it("defaults to the production posture: jailer ON, PATH binary, uid base 64000, cgroups ON", () => {
    for (const k of JAIL_KEYS) delete process.env[k];
    const env = freshEnv();
    expect(env.FIRECRACKER_JAILER).toBe("on");
    expect(env.FIRECRACKER_JAILER_BIN).toBe("jailer");
    expect(env.FIRECRACKER_JAIL_UID_BASE).toBe(64_000);
    expect(env.FIRECRACKER_JAIL_CGROUPS).toBe("on");
  });

  it("accepts the explicit dev escape hatches", () => {
    process.env.FIRECRACKER_JAILER = "off";
    process.env.FIRECRACKER_JAIL_CGROUPS = "off";
    process.env.FIRECRACKER_JAILER_BIN = "/opt/fc/jailer";
    const env = freshEnv();
    expect(env.FIRECRACKER_JAILER).toBe("off");
    expect(env.FIRECRACKER_JAIL_CGROUPS).toBe("off");
    expect(env.FIRECRACKER_JAILER_BIN).toBe("/opt/fc/jailer");
  });

  it("rejects anything outside the on/off enums", () => {
    process.env.FIRECRACKER_JAILER = "yes";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow();
  });

  it("coerces the uid base and refuses bases below the unprivileged floor", () => {
    process.env.FIRECRACKER_JAIL_UID_BASE = "70000";
    expect(freshEnv().FIRECRACKER_JAIL_UID_BASE).toBe(70_000);
    // uid < 1000 would hand VMs system uids — the schema refuses.
    process.env.FIRECRACKER_JAIL_UID_BASE = "500";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow();
  });
});

describe("FIRECRACKER_CREDENTIAL_BROKER", () => {
  const KEY = "FIRECRACKER_CREDENTIAL_BROKER";
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    _resetFirecrackerEnvCacheForTesting();
  });

  it("defaults to the MMDS broker (production posture)", () => {
    delete process.env[KEY];
    _resetFirecrackerEnvCacheForTesting();
    expect(getFirecrackerEnv().FIRECRACKER_CREDENTIAL_BROKER).toBe("mmds");
  });

  it("accepts the config-drive escape hatch", () => {
    process.env[KEY] = "config-drive";
    _resetFirecrackerEnvCacheForTesting();
    expect(getFirecrackerEnv().FIRECRACKER_CREDENTIAL_BROKER).toBe("config-drive");
  });

  it("rejects any other value", () => {
    process.env[KEY] = "vsock";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow();
  });
});
