// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";

import {
  assetName,
  compareSemver,
  detectPlatform,
  normalizeVersion,
  parseChecksumLine,
  releaseUrls,
  resolveTargetVersion,
  type SelfUpdateDeps,
} from "../src/lib/self-update.ts";
import { runSelfUpdate, SELF_UPDATE_EXIT } from "../src/commands/self-update.ts";

/**
 * Phase 2 — `appstrate self-update` (issue #249).
 *
 * Pure helpers (parsing, asset/url derivation, semver compare) get exhaustive
 * unit coverage. The full update flow is tested with a fake `SelfUpdateDeps`
 * that records every call — no network, no minisign, no real binary touched.
 */

describe("detectPlatform", () => {
  it("maps darwin/arm64 → { darwin, arm64 }", () => {
    expect(detectPlatform({ platform: "darwin", arch: "arm64" })).toEqual({
      platform: "darwin",
      arch: "arm64",
    });
  });

  it("maps linux/x64 → { linux, x64 }", () => {
    expect(detectPlatform({ platform: "linux", arch: "x64" })).toEqual({
      platform: "linux",
      arch: "x64",
    });
  });

  it("rejects win32", () => {
    expect(() => detectPlatform({ platform: "win32", arch: "x64" })).toThrow(
      /only supported on macOS and Linux/,
    );
  });

  it("rejects unsupported arch", () => {
    expect(() => detectPlatform({ platform: "linux", arch: "ia32" })).toThrow(
      /only supported on x64 and arm64/,
    );
  });
});

describe("assetName + releaseUrls", () => {
  it("builds the canonical asset name", () => {
    expect(assetName({ platform: "linux", arch: "arm64" })).toBe("appstrate-linux-arm64");
    expect(assetName({ platform: "darwin", arch: "x64" })).toBe("appstrate-darwin-x64");
  });

  it("builds /latest/download URLs when target is 'latest'", () => {
    const urls = releaseUrls("latest", { platform: "linux", arch: "x64" });
    expect(urls.binary).toBe(
      "https://github.com/appstrate/appstrate/releases/latest/download/appstrate-linux-x64",
    );
    expect(urls.checksums).toBe(
      "https://github.com/appstrate/appstrate/releases/latest/download/checksums.txt",
    );
    expect(urls.checksumsSig).toBe(
      "https://github.com/appstrate/appstrate/releases/latest/download/checksums.txt.minisig",
    );
  });

  it("builds /download/v<version>/ URLs for a pinned version", () => {
    const urls = releaseUrls("1.2.3", { platform: "darwin", arch: "arm64" });
    expect(urls.binary).toBe(
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/appstrate-darwin-arm64",
    );
  });

  it("does not double-prefix the v if the caller already passed v1.2.3", () => {
    const urls = releaseUrls("v1.2.3", { platform: "darwin", arch: "arm64" });
    expect(urls.binary).toBe(
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/appstrate-darwin-arm64",
    );
  });
});

describe("parseChecksumLine", () => {
  const goodHash = "a".repeat(64);
  const otherHash = "b".repeat(64);

  it("returns the hash for the matching asset", () => {
    const txt = `${goodHash}  appstrate-linux-x64\n${otherHash}  appstrate-darwin-arm64\n`;
    expect(parseChecksumLine(txt, "appstrate-linux-x64")).toBe(goodHash);
  });

  it("accepts the BSD `*<asset>` (binary mode) format", () => {
    const txt = `${goodHash}  *appstrate-linux-x64\n`;
    expect(parseChecksumLine(txt, "appstrate-linux-x64")).toBe(goodHash);
  });

  it("throws when the asset is missing", () => {
    expect(() =>
      parseChecksumLine(`${goodHash}  appstrate-darwin-x64\n`, "appstrate-linux-x64"),
    ).toThrow(/not listed in the signed checksums manifest/);
  });

  it("throws when the asset appears more than once", () => {
    const txt = `${goodHash}  appstrate-linux-x64\n${otherHash}  appstrate-linux-x64\n`;
    expect(() => parseChecksumLine(txt, "appstrate-linux-x64")).toThrow(
      /Expected exactly one line/,
    );
  });

  it("throws when the hash is not 64 hex chars", () => {
    const txt = `notahash  appstrate-linux-x64\n`;
    expect(() => parseChecksumLine(txt, "appstrate-linux-x64")).toThrow(/not 64 hex characters/);
  });
});

describe("compareSemver", () => {
  it("orders 1.2.3 < 1.2.4", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
  });

  it("orders 1.10.0 > 1.9.0 (numeric, not lexical)", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
  });

  it("treats v-prefixed and bare versions as equal", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
  });

  it("orders pre-releases as lower than the same release", () => {
    expect(compareSemver("1.0.0-alpha.5", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-alpha.5")).toBe(1);
  });

  it("orders pre-release identifiers per SemVer 2.0 §11.4 (numeric, not lexical)", () => {
    // Pure lexical compare would put alpha.10 BEFORE alpha.2 — SemVer 2.0 says
    // numeric identifiers compare numerically, so alpha.10 > alpha.2.
    expect(compareSemver("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
  });

  it("ranks numeric identifiers below alphanumeric per §11.4.3", () => {
    // 1.0.0-1 (numeric) < 1.0.0-alpha (alphanumeric).
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1);
  });

  it("ranks longer pre-release identifier sets higher per §11.4.4", () => {
    // alpha.1 > alpha — same prefix, more identifiers wins.
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });

  it("ignores build metadata per §10", () => {
    expect(compareSemver("1.2.3+sha.abcd", "1.2.3+sha.efgh")).toBe(0);
    expect(compareSemver("1.2.3+sha.abcd", "1.2.3")).toBe(0);
  });
});

describe("normalizeVersion", () => {
  it("strips leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
  });
  it("trims whitespace", () => {
    expect(normalizeVersion("  1.2.3 \n")).toBe("1.2.3");
  });
});

describe("resolveTargetVersion", () => {
  it("returns the requested version stripped of v", async () => {
    const out = await resolveTargetVersion("v1.4.0", {
      fetchText: async () => "should not be called",
    });
    expect(out).toBe("1.4.0");
  });

  it("rejects a non-semver requested version", async () => {
    await expect(
      resolveTargetVersion("not-a-version", { fetchText: async () => "" }),
    ).rejects.toThrow(/Invalid version/);
  });

  it("queries GitHub when no version is requested", async () => {
    const calls: string[] = [];
    const out = await resolveTargetVersion(undefined, {
      fetchText: async (url) => {
        calls.push(url);
        return JSON.stringify({ tag_name: "v2.5.0" });
      },
    });
    expect(out).toBe("2.5.0");
    expect(calls).toEqual(["https://api.github.com/repos/appstrate/appstrate/releases/latest"]);
  });

  it("throws on malformed GitHub response", async () => {
    await expect(
      resolveTargetVersion(undefined, { fetchText: async () => "not json" }),
    ).rejects.toThrow(/non-JSON/);
    await expect(resolveTargetVersion(undefined, { fetchText: async () => "{}" })).rejects.toThrow(
      /missing tag_name/,
    );
  });

  it("surfaces a clear error when GitHub returns 403 (rate limit)", async () => {
    const { HttpError } = await import("../src/lib/self-update.ts");
    await expect(
      resolveTargetVersion(undefined, {
        fetchText: async () => {
          throw new HttpError("403 forbidden", 403, "Forbidden", "https://api.github.com/…");
        },
      }),
    ).rejects.toThrow(/rate-limited|--release/);
  });
});

// ─── runSelfUpdate (channel dispatch + curl flow) ──────────────────────────

interface FakeDepsState {
  binary: Uint8Array;
  checksumsTxt: string;
  checksumsSig: Uint8Array;
  /** Hash returned by the fake sha256Hex — must match parseChecksumLine output for happy path. */
  hashOverride?: string;
  minisignAvailable: boolean;
  minisignOk: boolean;
  execPath: string;
  /** Side effects collected for assertions. */
  written: Array<{ path: string; bytes: number }>;
  replaced: Array<{ dest: string; bytes: number }>;
  fetched: string[];
  commands: Array<{ cmd: string; args: string[] }>;
}

function makeFakeDeps(state: FakeDepsState): SelfUpdateDeps {
  return {
    async fetchBinary(url) {
      state.fetched.push(url);
      if (url.endsWith(".minisig")) return state.checksumsSig;
      return state.binary;
    },
    async fetchText(url) {
      state.fetched.push(url);
      return state.checksumsTxt;
    },
    async sha256Hex(data) {
      // Either return the override (used to simulate mismatch) or produce a deterministic hash.
      if (state.hashOverride) return state.hashOverride;
      // Sum bytes for a stable, content-dependent fake hash. Tests inject the
      // matching value into checksumsTxt so the round-trip succeeds.
      let n = 0;
      for (const b of data) n = (n + b) | 0;
      return `${"f".repeat(60)}${(n & 0xffff).toString(16).padStart(4, "0")}`;
    },
    async runCommand(cmd, args) {
      state.commands.push({ cmd, args });
      if (cmd === "minisign") {
        if (!state.minisignAvailable) {
          return { ok: false, exitCode: -1, stdout: "", stderr: "ENOENT" };
        }
        return state.minisignOk
          ? { ok: true, exitCode: 0, stdout: "Signature OK", stderr: "" }
          : { ok: false, exitCode: 1, stdout: "", stderr: "BAD SIG" };
      }
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    execPath: () => state.execPath,
    async atomicReplace(bytes, dest) {
      state.replaced.push({ dest, bytes: bytes.byteLength });
    },
    async makeWorkDir() {
      return "/tmp/fake-work";
    },
    async removeDir() {
      // no-op
    },
    async writeFile(path, data) {
      state.written.push({
        path,
        bytes: typeof data === "string" ? data.length : data.byteLength,
      });
    },
  };
}

describe("runSelfUpdate — channel dispatch", () => {
  it("rejects bun source with an actionable npm hint", async () => {
    const out = await runSelfUpdate({ source: "bun" });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.WRONG_CHANNEL);
    expect(out.message).toContain("npm channel");
    expect(out.message).toContain("bun update -g appstrate");
  });

  it("rejects unknown source with a diagnostic", async () => {
    const out = await runSelfUpdate({
      source: "unknown",
      deps: makeFakeDeps({
        binary: new Uint8Array(),
        checksumsTxt: "",
        checksumsSig: new Uint8Array(),
        minisignAvailable: true,
        minisignOk: true,
        execPath: "/usr/local/bin/appstrate",
        written: [],
        replaced: [],
        fetched: [],
        commands: [],
      }),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UNKNOWN_SOURCE);
    expect(out.message).toContain("install-source stamp");
    expect(out.message).toContain("/usr/local/bin/appstrate");
  });
});

describe("runSelfUpdate — curl flow", () => {
  function freshState(overrides: Partial<FakeDepsState> = {}): FakeDepsState {
    const binary = new Uint8Array([1, 2, 3, 4, 5]);
    // Match the fake sha256 algorithm: sum bytes mod 0xffff.
    const sum = binary.reduce((a, b) => (a + b) | 0, 0) & 0xffff;
    const fakeHash = `${"f".repeat(60)}${sum.toString(16).padStart(4, "0")}`;
    return {
      binary,
      checksumsTxt: `${fakeHash}  appstrate-linux-x64\n`,
      checksumsSig: new Uint8Array([0xde, 0xad]),
      minisignAvailable: true,
      minisignOk: true,
      execPath: "/home/user/.local/bin/appstrate",
      written: [],
      replaced: [],
      fetched: [],
      commands: [],
      ...overrides,
    };
  }

  it("downloads, verifies and atomic-replaces on a real version", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });

    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toContain("Updated appstrate to 1.2.3");
    expect(state.fetched).toEqual([
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/appstrate-linux-x64",
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/checksums.txt",
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/checksums.txt.minisig",
    ]);
    expect(state.commands.find((c) => c.cmd === "minisign" && c.args[0] === "-Vm")).toBeTruthy();
    expect(state.replaced).toEqual([{ dest: "/home/user/.local/bin/appstrate", bytes: 5 }]);
  });

  it("reports already-up-to-date and skips replace when versions match", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.2.3",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toMatch(/Already on appstrate 1\.2\.3/);
    expect(state.replaced).toEqual([]);
  });

  it("--force reinstalls even when versions match", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.2.3",
      force: true,
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toContain("Updated appstrate to 1.2.3");
    expect(state.replaced).toHaveLength(1);
  });

  it("fails closed when minisign is missing", async () => {
    const state = freshState({ minisignAvailable: false });
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    expect(out.message).toContain("minisign is required");
    expect(state.replaced).toEqual([]);
  });

  it("fails closed when minisign reports a bad signature", async () => {
    const state = freshState({ minisignOk: false });
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    expect(out.message).toContain("Signature verification FAILED");
    expect(state.replaced).toEqual([]);
  });

  it("fails closed when SHA-256 does not match", async () => {
    const state = freshState({ hashOverride: "0".repeat(64) });
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    expect(out.message).toContain("SHA-256 mismatch");
    expect(state.replaced).toEqual([]);
  });

  it("blocks self-update on a dev build (CLI_VERSION === 0.0.0)", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "0.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    expect(out.message).toContain("dev build");
  });
});
