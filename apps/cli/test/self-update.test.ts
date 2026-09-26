// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";

import {
  APPSTRATE_MINISIGN_PUBKEY,
  assetName,
  compareSemver,
  detectPlatform,
  normalizeVersion,
  parseChecksumLine,
  releaseUrls,
  resolveTargetVersion,
  type ReleaseChannelDeps,
  type SelfUpdateDeps,
} from "../src/lib/self-update.ts";
import { runSelfUpdate, SELF_UPDATE_EXIT } from "../src/commands/self-update.ts";

/**
 * Phase 2 — `appstrate self-update` (issue #249).
 *
 * Pure helpers (parsing, asset/url derivation, semver compare) get exhaustive
 * unit coverage. Version resolution (the signed channel manifest) and the full
 * update flow are tested with fakes that record every call — no network, no
 * minisign, no real binary touched.
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

// ─── resolveTargetVersion (signed channel manifest) ────────────────────────

const MANIFEST_URL = "https://get.appstrate.dev/channels/latest.json";
const MANIFEST_SIG_URL = `${MANIFEST_URL}.minisig`;

/** A channel manifest body; `fields` override the valid defaults. */
function manifest(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, channel: "latest", tag: "v1.0.0-beta.63", ...fields });
}

interface ChannelFake {
  deps: ReleaseChannelDeps;
  fetched: string[];
  commands: Array<{ cmd: string; args: string[] }>;
  written: string[];
  removed: string[];
}

/** Records every side effect of a manifest resolution; no network, no minisign. */
function channelFake(
  opts: { body?: string; minisign?: "ok" | "missing" | "bad-sig"; fetchError?: string } = {},
): ChannelFake {
  const fake: Omit<ChannelFake, "deps"> = { fetched: [], commands: [], written: [], removed: [] };
  const get = (url: string) => {
    // The manifest replaced the GitHub API outright: no request may reach it.
    if (url.includes("api.github.com")) throw new Error(`GitHub API requested: ${url}`);
    fake.fetched.push(url);
    if (opts.fetchError) throw new Error(opts.fetchError);
  };
  return {
    ...fake,
    deps: {
      async fetchText(url) {
        get(url);
        return opts.body ?? manifest();
      },
      async fetchBinary(url) {
        get(url);
        return new Uint8Array([0xde, 0xad]);
      },
      async runCommand(cmd, args) {
        fake.commands.push({ cmd, args });
        if (opts.minisign === "missing") {
          return { ok: false, exitCode: -1, stdout: "", stderr: "ENOENT" };
        }
        if (opts.minisign === "bad-sig" && args[0] === "-V") {
          return { ok: false, exitCode: 1, stdout: "", stderr: "BAD SIG" };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
      async writeFile(path) {
        fake.written.push(path);
      },
      async makeWorkDir() {
        return "/tmp/fake-channel";
      },
      async removeDir(path) {
        fake.removed.push(path);
      },
    },
  };
}

describe("resolveTargetVersion", () => {
  it("returns a pinned version stripped of v without touching the network", async () => {
    const fake = channelFake();
    expect(await resolveTargetVersion("v1.4.0", fake.deps)).toBe("1.4.0");
    expect(fake.fetched).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  it("rejects a non-semver pinned version", async () => {
    const fake = channelFake();
    await expect(resolveTargetVersion("not-a-version", fake.deps)).rejects.toThrow(
      /Invalid version/,
    );
    expect(fake.fetched).toEqual([]);
  });

  it("resolves the tag the signed channel manifest names", async () => {
    const fake = channelFake();
    expect(await resolveTargetVersion(undefined, fake.deps)).toBe("1.0.0-beta.63");
    // Exactly the manifest and its signature — nothing else is requested.
    expect(fake.fetched).toEqual([MANIFEST_URL, MANIFEST_SIG_URL]);
    expect(fake.written).toEqual([
      "/tmp/fake-channel/latest.json",
      "/tmp/fake-channel/latest.json.minisig",
    ]);
    expect(fake.commands).toEqual([
      { cmd: "minisign", args: ["-v"] },
      {
        cmd: "minisign",
        args: [
          "-V",
          "-m",
          "/tmp/fake-channel/latest.json",
          "-x",
          "/tmp/fake-channel/latest.json.minisig",
          "-P",
          APPSTRATE_MINISIGN_PUBKEY,
        ],
      },
    ]);
    // The scratch copies are cleaned up like the checksums ones.
    expect(fake.removed).toEqual(["/tmp/fake-channel"]);
  });

  it("fails closed before any download when minisign is missing", async () => {
    const fake = channelFake({ minisign: "missing" });
    await expect(resolveTargetVersion(undefined, fake.deps)).rejects.toThrow(
      /minisign is required to verify the release channel manifest[\s\S]*--release X\.Y\.Z/,
    );
    expect(fake.fetched).toEqual([]);
  });

  it("fails closed on a bad signature, before parsing and without fetching anything else", async () => {
    // An unparseable body proves the order: the signature error wins, the
    // bytes are never read.
    const fake = channelFake({ minisign: "bad-sig", body: "not json" });
    await expect(resolveTargetVersion(undefined, fake.deps)).rejects.toThrow(
      /Signature verification FAILED: the release channel manifest[\s\S]*--release X\.Y\.Z/,
    );
    expect(fake.fetched).toEqual([MANIFEST_URL, MANIFEST_SIG_URL]);
    expect(fake.written).toHaveLength(2);
    expect(fake.removed).toEqual(["/tmp/fake-channel"]);
  });

  it("fails with the pin escape hatch when the manifest cannot be fetched", async () => {
    const fake = channelFake({ fetchError: `GET ${MANIFEST_URL} → 503 Service Unavailable` });
    await expect(resolveTargetVersion(undefined, fake.deps)).rejects.toThrow(
      /503 Service Unavailable[\s\S]*--release X\.Y\.Z/,
    );
    expect(fake.written).toEqual([]);
    expect(fake.removed).toEqual(["/tmp/fake-channel"]);
  });

  it("rejects a manifest that is not JSON", async () => {
    await expect(
      resolveTargetVersion(undefined, channelFake({ body: "not json" }).deps),
    ).rejects.toThrow(/not valid JSON[\s\S]*--release X\.Y\.Z/);
  });

  it("rejects any schema other than 1", async () => {
    for (const body of [manifest({ schema: 2 }), manifest({ schema: "1" }), "{}", "null"]) {
      await expect(resolveTargetVersion(undefined, channelFake({ body }).deps)).rejects.toThrow(
        /Unsupported channel manifest schema/,
      );
    }
  });

  it("rejects a manifest for another channel", async () => {
    await expect(
      resolveTargetVersion(undefined, channelFake({ body: manifest({ channel: "beta" }) }).deps),
    ).rejects.toThrow(/channel "beta", not "latest"/);
  });

  it("rejects a tag that is not a platform v<semver> tag", async () => {
    for (const tag of ["core@12.0.0", "1.2.3", "v1.2", "v1.2.3+build", "v1.2.3-x/../y", 123]) {
      await expect(
        resolveTargetVersion(undefined, channelFake({ body: manifest({ tag }) }).deps),
      ).rejects.toThrow(/not a platform v<semver> release tag/);
    }
  });
});

// ─── runSelfUpdate (channel dispatch + curl flow) ──────────────────────────

interface FakeDepsState {
  binary: Uint8Array;
  checksumsTxt: string;
  checksumsSig: Uint8Array;
  /** Body served for the channel manifest (an unpinned run); defaults to a valid one. */
  channelManifest?: string;
  /** SHA-256 returned by the fake fetchToFile — must match parseChecksumLine output for happy path. */
  hashOverride?: string;
  /** When set, the small manifest fetch (fetchText) rejects with this message. */
  checksumsError?: string;
  minisignAvailable: boolean;
  minisignOk: boolean;
  execPath: string;
  /** Side effects collected for assertions. */
  written: Array<{ path: string; bytes: number }>;
  replaced: Array<{ dest: string }>;
  fetched: string[];
  commands: Array<{ cmd: string; args: string[] }>;
}

/** Deterministic content-dependent fake SHA (matches the checksumsTxt fixtures). */
function fakeSha(data: Uint8Array): string {
  let n = 0;
  for (const b of data) n = (n + b) | 0;
  return `${"f".repeat(60)}${(n & 0xffff).toString(16).padStart(4, "0")}`;
}

function makeFakeDeps(state: FakeDepsState): SelfUpdateDeps {
  return {
    async fetchToFile(url, _dest, onProgress) {
      state.fetched.push(url);
      onProgress?.({
        received: state.binary.byteLength,
        total: state.binary.byteLength,
        rateBytesPerSec: 1,
      });
      // Simulate a tampered download by overriding the streamed digest.
      return { sha256: state.hashOverride ?? fakeSha(state.binary) };
    },
    async fetchBinary(url) {
      state.fetched.push(url);
      if (url.endsWith(".minisig")) return state.checksumsSig;
      return state.binary;
    },
    async fetchText(url) {
      state.fetched.push(url);
      if (url === MANIFEST_URL) return state.channelManifest ?? manifest();
      if (state.checksumsError) throw new Error(state.checksumsError);
      return state.checksumsTxt;
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
    async promoteFile(_staged, dest) {
      state.replaced.push({ dest });
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
    // Signed manifest first (checksums + sig), then the large binary stream.
    expect(state.fetched).toEqual([
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/checksums.txt",
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/checksums.txt.minisig",
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/appstrate-linux-x64",
    ]);
    expect(state.commands).toContainEqual({
      cmd: "minisign",
      args: [
        "-V",
        "-m",
        "/tmp/fake-work/checksums.txt",
        "-x",
        "/tmp/fake-work/checksums.txt.minisig",
        "-P",
        APPSTRATE_MINISIGN_PUBKEY,
      ],
    });
    expect(state.replaced).toEqual([{ dest: "/home/user/.local/bin/appstrate" }]);
  });

  it("resolves an unpinned run from the signed channel manifest, then pins its downloads", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      currentVersion: "1.0.0-beta.62",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toContain("Updated appstrate to 1.0.0-beta.63");
    const base = "https://github.com/appstrate/appstrate/releases/download/v1.0.0-beta.63";
    expect(state.fetched).toEqual([
      MANIFEST_URL,
      MANIFEST_SIG_URL,
      `${base}/checksums.txt`,
      `${base}/checksums.txt.minisig`,
      `${base}/appstrate-linux-x64`,
    ]);
    // Both signed files go through the same minisign verification.
    expect(state.commands.filter((c) => c.args[0] === "-V").map((c) => c.args[2])).toEqual([
      "/tmp/fake-work/latest.json",
      "/tmp/fake-work/checksums.txt",
    ]);
  });

  it("fails with the --release escape hatch when the channel manifest is invalid", async () => {
    const state = freshState({ channelManifest: manifest({ tag: "core@12.0.0" }) });
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    expect(out.message).toContain("Could not resolve target version");
    expect(out.message).toContain("--release X.Y.Z");
    // Nothing past the manifest was fetched, nothing was installed.
    expect(state.fetched).toEqual([MANIFEST_URL, MANIFEST_SIG_URL]);
    expect(state.replaced).toEqual([]);
  });

  it("stages the download under a fixed hidden name (retry overwrites a crashed partial)", async () => {
    const state = freshState();
    const deps = makeFakeDeps(state);
    let stagedSeen: string | undefined;
    const basePromote = deps.promoteFile;
    deps.promoteFile = async (staged, dest) => {
      stagedSeen = staged;
      await basePromote(staged, dest);
    };
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps,
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    // No pid suffix: a retry after crash/SIGKILL overwrites the previous
    // partial file instead of accumulating hidden ~113 MB orphans.
    expect(stagedSeen).toBe("/home/user/.local/bin/.appstrate.download");
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

  it("refuses to downgrade when the target is older than the running binary", async () => {
    // Issue #1361: the second half of the guard. Even if a resolver bug or a
    // vanished release hands back an older tag, the binary is never replaced.
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.0.1",
      currentVersion: "1.1.0",
      deps: makeFakeDeps(state),
    });
    // Exit 0, not a failure code: unattended runs on a box that is ahead of
    // the newest release must not start failing.
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toMatch(/NEWER than 1\.0\.1/);
    expect(out.message).toMatch(/--force/);
    expect(state.replaced).toEqual([]);
    // Nothing was even downloaded.
    expect(state.fetched).toEqual([]);
  });

  it("--force downgrades deliberately", async () => {
    const state = freshState();
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "9.9.9",
      force: true,
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.OK);
    expect(out.message).toContain("Updated appstrate to 1.2.3");
    expect(state.replaced).toHaveLength(1);
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

  it("never starts the binary stream when the manifest fetch fails (no orphan staged download)", async () => {
    const state = freshState({ checksumsError: "GET checksums.txt → HTTP 500" });
    const binaryUrl =
      "https://github.com/appstrate/appstrate/releases/download/v1.2.3/appstrate-linux-x64";
    const out = await runSelfUpdate({
      source: "curl",
      platform: { platform: "linux", arch: "x64" },
      log: () => {},
      version: "1.2.3",
      currentVersion: "1.0.0",
      deps: makeFakeDeps(state),
    });
    expect(out.exitCode).toBe(SELF_UPDATE_EXIT.UPDATE_FAILED);
    // The large binary is fetched AFTER the signed manifest, so a manifest
    // failure means the stream never started — nothing to leak on disk.
    expect(state.fetched).not.toContain(binaryUrl);
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
