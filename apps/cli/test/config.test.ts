// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/config.ts` — TOML round-trip + profile-resolution
 * cascade. Each test points `_setConfigPathForTesting` at a tmpdir so
 * the user's real `~/.config/appstrate/` is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConfig,
  writeConfig,
  getProfile,
  setProfile,
  updateProfile,
  deleteProfile,
  listProfiles,
  resolveProfileName,
  type Config,
} from "../src/lib/config.ts";

let tmpDir: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  // Redirect the whole XDG tree at a per-test tmpdir so `config.ts`
  // uses it naturally via its production path-resolution (no test
  // backdoor). `~/.config/appstrate/` is never touched.
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-config-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.APPSTRATE_PROFILE;
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("returns an empty config when the file is absent", async () => {
    const config = await readConfig();
    expect(config.defaultProfile).toBe("default");
    expect(config.profiles).toEqual({});
  });

  it("parses a file written by writeConfig", async () => {
    const input: Config = {
      defaultProfile: "prod",
      profiles: {
        prod: {
          instance: "https://app.example.com",
          userId: "u1",
          email: "a@b.c",
          orgId: "o1",
          appId: "a1",
        },
        dev: { instance: "http://localhost:3000", userId: "u2", email: "x@y.z" },
      },
    };
    await writeConfig(input);
    const read = await readConfig();
    expect(read).toEqual(input);
  });

  it("round-trips a profile without appId unchanged (forward-compat)", async () => {
    // Legacy profiles predating #217 have `orgId` but no `appId`. They
    // must parse cleanly and write back without materializing a phantom
    // `appId = ""` entry in the TOML file.
    const input: Config = {
      defaultProfile: "legacy",
      profiles: {
        legacy: {
          instance: "https://app.example.com",
          userId: "u1",
          email: "a@b.c",
          orgId: "o1",
        },
      },
    };
    await writeConfig(input);
    const read = await readConfig();
    expect(read).toEqual(input);
    expect(read.profiles.legacy!.appId).toBeUndefined();
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(tmpDir, "appstrate", "config.toml"), "utf-8");
    expect(raw).not.toContain("appId");
  });

  it("skips malformed profile rows without throwing", async () => {
    // Hand-write a bad file — simulate a user editing config.toml with a
    // missing `email` field. We want `readConfig` to ignore it, not crash.
    const bad = [
      'defaultProfile = "prod"',
      "[profile.ok]",
      'instance = "https://a.example"',
      'userId = "u"',
      'email = "x@y.z"',
      "[profile.bad]",
      'instance = "https://b.example"',
      // missing userId + email
    ].join("\n");
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(tmpDir, "appstrate"), { recursive: true });
    await fs.writeFile(join(tmpDir, "appstrate", "config.toml"), bad);
    const config = await readConfig();
    expect(Object.keys(config.profiles)).toEqual(["ok"]);
  });
});

describe("writeConfig", () => {
  it("writes the file with 0600 permissions", async () => {
    await writeConfig({
      defaultProfile: "default",
      profiles: { default: { instance: "https://a", userId: "u", email: "e" } },
    });
    const { stat } = await import("node:fs/promises");
    const s = await stat(join(tmpDir, "appstrate", "config.toml"));
    // On systems where umask would normally widen the mode, the
    // explicit `mode: 0o600` on `writeFile` + our `chmod` follow-up must
    // still produce user-only access.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("is atomic — tmp files get cleaned up", async () => {
    await writeConfig({
      defaultProfile: "default",
      profiles: { default: { instance: "https://a", userId: "u", email: "e" } },
    });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmpDir);
    // No `.tmp` files lingering after a successful write.
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});

describe("setProfile + getProfile + deleteProfile", () => {
  it("round-trips a profile", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "o",
    });
    const p = await getProfile("dev");
    expect(p).toEqual({
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "o",
    });
  });

  it("sets defaultProfile to the first written profile", async () => {
    await setProfile("prod", { instance: "https://a", userId: "u", email: "e" });
    const config = await readConfig();
    expect(config.defaultProfile).toBe("prod");
  });

  it("leaves defaultProfile alone on subsequent writes", async () => {
    await setProfile("first", { instance: "https://a", userId: "u", email: "e" });
    await setProfile("second", { instance: "https://b", userId: "u2", email: "e2" });
    const config = await readConfig();
    expect(config.defaultProfile).toBe("first");
  });

  it("deleteProfile returns false when the profile is absent", async () => {
    const ok = await deleteProfile("missing");
    expect(ok).toBe(false);
  });

  it("deleteProfile removes the profile and repoints defaultProfile if needed", async () => {
    await setProfile("a", { instance: "https://a", userId: "u", email: "e" });
    await setProfile("b", { instance: "https://b", userId: "u", email: "e" });
    // a is the default (first written). Delete it — default should repoint to b.
    const ok = await deleteProfile("a");
    expect(ok).toBe(true);
    const config = await readConfig();
    expect(config.defaultProfile).toBe("b");
    expect(await listProfiles()).toEqual(["b"]);
  });

  it("deleteProfile falls back to 'default' when no profiles remain", async () => {
    await setProfile("only", { instance: "https://a", userId: "u", email: "e" });
    await deleteProfile("only");
    const config = await readConfig();
    expect(config.defaultProfile).toBe("default");
    expect(await listProfiles()).toEqual([]);
  });
});

describe("updateProfile", () => {
  it("merges a partial patch into an existing profile", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
    });
    await updateProfile("dev", { appId: "app_1" });
    const after = await getProfile("dev");
    expect(after).toEqual({
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
      appId: "app_1",
    });
  });

  it("treats `undefined` in the patch as 'clear this key'", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
      appId: "app_1",
    });
    // Clearing appId should drop the key entirely — not leave an explicit
    // `appId: undefined` that TOML would serialize as `appId = ""`.
    await updateProfile("dev", { appId: undefined });
    const after = await getProfile("dev");
    expect(after!.appId).toBeUndefined();
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(tmpDir, "appstrate", "config.toml"), "utf-8");
    expect(raw).not.toContain("appId");
  });

  it("rewrites multiple fields atomically — orgId + appId in one call", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_old",
      appId: "app_old",
    });
    // Simulates `org switch` cascade: swap org and clear app pin in one write.
    await updateProfile("dev", { orgId: "org_new", appId: undefined });
    const after = await getProfile("dev");
    expect(after!.orgId).toBe("org_new");
    expect(after!.appId).toBeUndefined();
  });

  it("throws when the profile is missing (invariant: runLogin writes first)", async () => {
    await expect(updateProfile("ghost", { orgId: "o" })).rejects.toThrow(/missing/);
  });

  it("preserves unrelated fields", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
    });
    await updateProfile("dev", { appId: "app_1" });
    const after = await getProfile("dev");
    expect(after!.instance).toBe("http://localhost:3000");
    expect(after!.userId).toBe("u");
    expect(after!.email).toBe("e");
    expect(after!.orgId).toBe("org_1");
  });
});

describe("resolveProfileName", () => {
  const base: Config = { defaultProfile: "prod", profiles: {} };

  it("returns the explicit argument when provided", () => {
    expect(resolveProfileName("explicit", base)).toBe("explicit");
  });

  it("falls back to APPSTRATE_PROFILE env var", () => {
    process.env.APPSTRATE_PROFILE = "fromenv";
    expect(resolveProfileName(undefined, base)).toBe("fromenv");
  });

  it("falls back to defaultProfile", () => {
    expect(resolveProfileName(undefined, { ...base, defaultProfile: "prod" })).toBe("prod");
  });

  it("falls back to literal 'default' as last resort", () => {
    expect(resolveProfileName(undefined, { defaultProfile: "", profiles: {} })).toBe("default");
  });

  it("gives precedence to explicit over env", () => {
    process.env.APPSTRATE_PROFILE = "fromenv";
    expect(resolveProfileName("explicit", base)).toBe("explicit");
  });
});

describe("TOML file format", () => {
  it("writes keys as [profile.<name>] sections", async () => {
    await setProfile("prod", { instance: "https://a", userId: "u1", email: "e@e" });
    const raw = await readFile(join(tmpDir, "appstrate", "config.toml"), "utf-8");
    expect(raw).toContain("[profile.prod]");
    expect(raw).toContain('instance = "https://a"');
  });
});
