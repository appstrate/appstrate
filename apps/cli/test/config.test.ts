// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/config.ts` — TOML round-trip + profile-resolution
 * cascade. Each test points `_setConfigPathForTesting` at a tmpdir so
 * the user's real `~/.config/appstrate/` is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  getProfile,
  setProfile,
  updateProfile,
  deleteProfile,
  listProfiles,
  resolveProfileName,
  resolveActiveProfileOrNull,
  type Config,
} from "../src/lib/config.ts";
import { useTempConfigHome } from "./helpers/auth-fixture.ts";

// Redirects the whole XDG tree at a per-test tmpdir so `config.ts` uses it
// naturally via its production path-resolution (no test backdoor).
// `~/.config/appstrate/` is never touched.
const configHome = useTempConfigHome("appstrate-cli-config-");

beforeEach(async () => {
  await configHome.setup();
  delete process.env.APPSTRATE_PROFILE;
});

afterEach(async () => {
  await configHome.teardown();
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
          spaceId: "spc_1",
        },
        dev: { instance: "http://localhost:3000", userId: "u2", email: "x@y.z" },
      },
    };
    await writeConfig(input);
    const read = await readConfig();
    expect(read).toEqual(input);
  });

  it("round-trips a profile without spaceId unchanged", async () => {
    // A profile that has never pinned a space has `orgId` but no `spaceId` —
    // `login` writes the field only when it carries one over, and `space
    // current` handles the unpinned case. It must parse cleanly and write back
    // without materializing a phantom `spaceId = ""` entry in the TOML file.
    const input: Config = {
      defaultProfile: "unpinned",
      profiles: {
        unpinned: {
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
    expect(read.profiles.unpinned!.spaceId).toBeUndefined();
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(configHome.dir(), "appstrate", "config.toml"), "utf-8");
    expect(raw).not.toContain("spaceId");
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
    await fs.mkdir(join(configHome.dir(), "appstrate"), { recursive: true });
    await fs.writeFile(join(configHome.dir(), "appstrate", "config.toml"), bad);
    const config = await readConfig();
    expect(Object.keys(config.profiles)).toEqual(["ok"]);
  });

  it("parses a profile that carries only `spaceId`", async () => {
    const good = [
      'defaultProfile = "prod"',
      "[profile.prod]",
      'instance = "https://a.example"',
      'userId = "u"',
      'email = "x@y.z"',
      'orgId = "org_1"',
      'spaceId = "spc_1"',
    ].join("\n");
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(configHome.dir(), "appstrate"), { recursive: true });
    await fs.writeFile(join(configHome.dir(), "appstrate", "config.toml"), good);

    const config = await readConfig();
    expect(config.profiles.prod).toEqual({
      instance: "https://a.example",
      userId: "u",
      email: "x@y.z",
      orgId: "org_1",
      spaceId: "spc_1",
    });
  });

  it("drops an unknown key rather than spreading the raw TOML row", async () => {
    // The parse is an ALLOW-LIST. A version that spread the row wholesale would
    // surface whatever the file happened to carry on the returned object, which
    // is how an unrecognised key reaches code that never declared it.
    const repaired = [
      'defaultProfile = "prod"',
      "[profile.prod]",
      'instance = "https://a.example"',
      'userId = "u"',
      'email = "x@y.z"',
      'spaceId = "spc_1"',
      'somethingElse = "nope"',
    ].join("\n");
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(configHome.dir(), "appstrate"), { recursive: true });
    await fs.writeFile(join(configHome.dir(), "appstrate", "config.toml"), repaired);

    const prod = (await readConfig()).profiles.prod!;
    expect(prod.spaceId).toBe("spc_1");
    expect(Object.keys(prod)).not.toContain("somethingElse");
    expect((prod as unknown as Record<string, unknown>).somethingElse).toBeUndefined();
  });
});

describe("writeConfig", () => {
  it("writes the file with 0600 permissions", async () => {
    await writeConfig({
      defaultProfile: "default",
      profiles: { default: { instance: "https://a", userId: "u", email: "e" } },
    });
    const { stat } = await import("node:fs/promises");
    const s = await stat(join(configHome.dir(), "appstrate", "config.toml"));
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
    const entries = await readdir(configHome.dir());
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
    await updateProfile("dev", { spaceId: "spc_1" });
    const after = await getProfile("dev");
    expect(after).toEqual({
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
      spaceId: "spc_1",
    });
  });

  it("treats `undefined` in the patch as 'clear this key'", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_1",
      spaceId: "spc_1",
    });
    // Clearing spaceId should drop the key entirely — not leave an explicit
    // `spaceId: undefined` that TOML would serialize as `spaceId = ""`.
    await updateProfile("dev", { spaceId: undefined });
    const after = await getProfile("dev");
    expect(after!.spaceId).toBeUndefined();
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(configHome.dir(), "appstrate", "config.toml"), "utf-8");
    expect(raw).not.toContain("spaceId");
  });

  it("rewrites multiple fields atomically — orgId + spaceId in one call", async () => {
    await setProfile("dev", {
      instance: "http://localhost:3000",
      userId: "u",
      email: "e",
      orgId: "org_old",
      spaceId: "spc_old",
    });
    // Simulates `org switch` cascade: swap org and clear space pin in one write.
    await updateProfile("dev", { orgId: "org_new", spaceId: undefined });
    const after = await getProfile("dev");
    expect(after!.orgId).toBe("org_new");
    expect(after!.spaceId).toBeUndefined();
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
    await updateProfile("dev", { spaceId: "spc_1" });
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
    const raw = await readFile(join(configHome.dir(), "appstrate", "config.toml"), "utf-8");
    expect(raw).toContain("[profile.prod]");
    expect(raw).toContain('instance = "https://a"');
  });
});

describe("resolveActiveProfileOrNull", () => {
  async function writeConfigFile(body: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const dir = join(configHome.dir(), "appstrate");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "config.toml"), body);
  }

  it("returns the resolution (profile undefined) when there is no config file at all", async () => {
    // The invariant `appstrate run --api-key` depends on: no profile is not an
    // error, so the resolution still comes back and the caller reads
    // `profile === undefined`.
    const resolved = await resolveActiveProfileOrNull(undefined);
    expect(resolved).toEqual({ profileName: "default", profile: undefined });
  });

  it("degrades an unparseable config file to null", async () => {
    await writeConfigFile("this is not [ valid toml");
    expect(await resolveActiveProfileOrNull(undefined)).toBeNull();
  });
});
