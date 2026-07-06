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
import {
  getFirecrackerEnv,
  jailUidRange,
  _resetFirecrackerEnvCacheForTesting,
} from "../../runner/host-env.ts";

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

  it("defaults to the production posture: jailer ON, PATH binary, uid base 200000, cgroups ON", () => {
    for (const k of JAIL_KEYS) delete process.env[k];
    const env = freshEnv();
    expect(env.FIRECRACKER_JAILER).toBe("on");
    expect(env.FIRECRACKER_JAILER_BIN).toBe("jailer");
    // Above the whole 16-bit uid space: the per-VM range must never cross
    // nobody (65534/65535) or the systemd DynamicUser pool (61184–65519).
    expect(env.FIRECRACKER_JAIL_UID_BASE).toBe(200_000);
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

  it("rejects uid ranges intersecting nobody / systemd DynamicUser (S-3)", () => {
    // Base inside the DynamicUser pool (61184–65519).
    process.env.FIRECRACKER_JAIL_UID_BASE = "64000";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow(/DynamicUser/);
    // Base below the pool whose range CROSSES into it (default 16 VMs).
    process.env.FIRECRACKER_JAIL_UID_BASE = "61180";
    _resetFirecrackerEnvCacheForTesting();
    expect(() => getFirecrackerEnv()).toThrow(/DynamicUser/);
    // Just past nobody: clean.
    process.env.FIRECRACKER_JAIL_UID_BASE = "65536";
    expect(freshEnv().FIRECRACKER_JAIL_UID_BASE).toBe(65_536);
  });

  it("validates the uid range against the ALLOCATOR ceiling when the VM cap is unlimited", () => {
    // With FIRECRACKER_MAX_CONCURRENT_VMS=0 the reachable index span is the
    // full 16319 — a base of 50000 then crosses 61184.
    process.env.FIRECRACKER_JAIL_UID_BASE = "50000";
    process.env.FIRECRACKER_MAX_CONCURRENT_VMS = "0";
    _resetFirecrackerEnvCacheForTesting();
    try {
      expect(() => getFirecrackerEnv()).toThrow(/DynamicUser/);
    } finally {
      delete process.env.FIRECRACKER_MAX_CONCURRENT_VMS;
    }
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

describe("jailUidRange", () => {
  const VMS_KEY = "FIRECRACKER_MAX_CONCURRENT_VMS";
  const BASE_KEY = "FIRECRACKER_JAIL_UID_BASE";
  const savedVms = process.env[VMS_KEY];
  const savedBase = process.env[BASE_KEY];

  afterEach(() => {
    if (savedVms === undefined) delete process.env[VMS_KEY];
    else process.env[VMS_KEY] = savedVms;
    if (savedBase === undefined) delete process.env[BASE_KEY];
    else process.env[BASE_KEY] = savedBase;
    _resetFirecrackerEnvCacheForTesting();
  });

  it("spans base..base+cap with admission control on", () => {
    process.env[BASE_KEY] = "200000";
    process.env[VMS_KEY] = "16";
    _resetFirecrackerEnvCacheForTesting();
    expect(jailUidRange(getFirecrackerEnv())).toEqual({ base: 200_000, hi: 200_016 });
  });

  it("falls back to the full allocator ceiling when the cap is the explicit 0", () => {
    process.env[BASE_KEY] = "200000";
    process.env[VMS_KEY] = "0";
    _resetFirecrackerEnvCacheForTesting();
    expect(jailUidRange(getFirecrackerEnv())).toEqual({ base: 200_000, hi: 216_319 });
  });
});
