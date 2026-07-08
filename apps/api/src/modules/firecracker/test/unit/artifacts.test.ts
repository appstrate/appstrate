// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the guest-artifact resolver (runner/artifacts.ts).
 *
 * Everything is driven through dependency injection — an in-memory
 * filesystem, a scripted fetch, and a stub zstd decompressor — so the
 * download / verify / atomic-install / skip logic is exercised with no
 * network, no real disk, and no `mock.module()` (a hard repo rule).
 *
 * The manifest is signature-gated (P1-4): every release scenario signs its
 * manifest with an in-test Ed25519 keypair and injects the matching public
 * key through the `manifestPublicKey` deps seam — the real verification
 * code path runs on every download, with real crypto, never disabled.
 */

import { describe, it, expect } from "bun:test";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import {
  ensureGuestArtifacts,
  FatalArtifactsError,
  GUEST_PROTOCOL_VERSION,
  resolveArch,
  type ArtifactsDeps,
  type ArtifactsFs,
} from "../../runner/artifacts.ts";

const KERNEL_PATH = "/data/fc/vmlinux";
const ROOTFS_PATH = "/data/fc/rootfs.ext4";
const MARKER_PATH = "/data/fc/.firecracker-artifacts.json";
const BASE_URL = "https://example.test/releases";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Manifest signing fixtures (P1-4 — the manifest is the root of trust)
// ---------------------------------------------------------------------------

const SIGNING_KEYPAIR = generateKeyPairSync("ed25519");
/** Base64 raw 32-byte public key, the format the resolver expects. */
const PUBKEY_B64 = Buffer.from(
  SIGNING_KEYPAIR.publicKey.export({ format: "jwk" }).x as string,
  "base64url",
).toString("base64");

const WRONG_KEYPAIR = generateKeyPairSync("ed25519");

/** Detached base64 Ed25519 signature over the manifest's exact JSON bytes. */
function signManifest(manifest: unknown, privateKey = SIGNING_KEYPAIR.privateKey): string {
  return ed25519Sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString("base64");
}

/**
 * Build the `ArtifactsDeps` for an `ensureGuestArtifacts` call with the constant
 * test defaults (`arch: "x86_64"`, the in-test signing key) pre-filled, so each
 * call site only spells out what it actually varies — the scenario's
 * `fetchFn`/`decompressZstd`, its in-memory `fs`, or an override (a different
 * arch, or `manifestPublicKey: undefined` to exercise the env/placeholder key
 * resolution). One place to touch when a new dep field lands, not every test.
 */
function depsFor(overrides: Partial<ArtifactsDeps> = {}): ArtifactsDeps {
  return {
    arch: "x86_64",
    manifestPublicKey: PUBKEY_B64,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory filesystem fake
// ---------------------------------------------------------------------------

function makeFs(initial: Record<string, Uint8Array | string> = {}): {
  fs: ArtifactsFs;
  files: Map<string, Uint8Array | string>;
  ops: string[];
} {
  const files = new Map<string, Uint8Array | string>(Object.entries(initial));
  const ops: string[] = [];
  const fs: ArtifactsFs = {
    async exists(path) {
      return files.has(path);
    },
    async readText(path) {
      const v = files.get(path);
      if (v === undefined) return null;
      return typeof v === "string" ? v : Buffer.from(v).toString("utf8");
    },
    async writeText(path, text) {
      ops.push(`writeText:${path}`);
      files.set(path, text);
    },
    async mkdirp(dir) {
      ops.push(`mkdirp:${dir}`);
    },
    async writeBytes(path, bytes) {
      ops.push(`writeBytes:${path}`);
      files.set(path, bytes);
    },
    async rename(from, to) {
      ops.push(`rename:${from}->${to}`);
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    async remove(path) {
      ops.push(`remove:${path}`);
      files.delete(path);
    },
  };
  return { fs, files, ops };
}

// ---------------------------------------------------------------------------
// Scripted fetch fake
// ---------------------------------------------------------------------------

interface FakeAsset {
  status?: number;
  bytes?: Uint8Array;
  json?: unknown;
  /** Lazily computed body — evaluated at fetch time (e.g. a signature over a manifest a test mutates after scenario()). */
  text?: () => string;
}

function makeFetch(assets: Record<string, FakeAsset>): {
  fetchFn: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const name = url.split("/").pop() ?? "";
    const asset = assets[name];
    if (!asset) return new Response("not found", { status: 404 });
    if (asset.status && asset.status >= 400) return new Response("error", { status: asset.status });
    if (asset.text !== undefined) return new Response(asset.text(), { status: 200 });
    if (asset.json !== undefined) return new Response(JSON.stringify(asset.json), { status: 200 });
    return new Response(asset.bytes ?? new Uint8Array(), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** A fetch that rejects (network unreachable). */
const throwingFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Scenario builder (a valid, self-consistent release)
// ---------------------------------------------------------------------------

function scenario(overrides: { guestProtocol?: number; arch?: string; version?: string } = {}) {
  const arch = overrides.arch ?? "x86_64";
  const version = overrides.version ?? "1.2.3";
  const kernelBytes = new Uint8Array([1, 2, 3, 4, 5]);
  const rootfsPlain = new Uint8Array([9, 8, 7, 6, 5, 4, 3]);
  const rootfsCompressed = new Uint8Array([200, 201, 202]); // stand-in .zst blob

  const manifest = {
    version,
    guest_protocol: overrides.guestProtocol ?? GUEST_PROTOCOL_VERSION,
    artifacts: {
      [arch]: {
        vmlinux: { sha256: sha256(kernelBytes), size: kernelBytes.length },
        rootfs: {
          sha256: sha256(rootfsPlain),
          size: rootfsPlain.length,
          compressed_size: rootfsCompressed.length,
        },
      },
    },
  };

  // Manifest AND signature are computed lazily at fetch time over the same
  // object, so a test that corrupts the manifest after scenario() still gets
  // a VALID signature over the corrupted bytes — exercising the checksum
  // gate, not the signature gate.
  const assets: Record<string, FakeAsset> = {
    "firecracker-artifacts-manifest.json": { json: manifest },
    "firecracker-artifacts-manifest.json.sig": { text: () => signManifest(manifest) },
    [`vmlinux-${arch}`]: { bytes: kernelBytes },
    [`rootfs-${arch}.ext4.zst`]: { bytes: rootfsCompressed },
  };
  const { fetchFn, calls } = makeFetch(assets);

  return {
    arch,
    version,
    kernelBytes,
    rootfsPlain,
    rootfsCompressed,
    manifest,
    assets,
    fetchFn,
    calls,
    decompressZstd: () => rootfsPlain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveArch", () => {
  it("maps node arch labels to the CI publication labels", () => {
    expect(resolveArch("x64")).toBe("x86_64");
    expect(resolveArch("arm64")).toBe("aarch64");
  });

  it("throws a fatal error on an unsupported arch", () => {
    expect(() => resolveArch("s390x")).toThrow(FatalArtifactsError);
  });
});

describe("ensureGuestArtifacts — install", () => {
  it("downloads, verifies, decompresses, and installs both artifacts + marker", async () => {
    const s = scenario();
    const { fs, files } = makeFs();

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(files.get(KERNEL_PATH)).toEqual(s.kernelBytes);
    expect(files.get(ROOTFS_PATH)).toEqual(s.rootfsPlain);
    // Marker records the installed release version + protocol.
    const marker = JSON.parse(files.get(MARKER_PATH) as string);
    expect(marker).toEqual({
      version: "1.2.3",
      guest_protocol: GUEST_PROTOCOL_VERSION,
      signed: true,
    });
  });

  it("hits the `latest` URL when no version is pinned and a versioned URL when pinned", async () => {
    const unpinned = scenario();
    const fsA = makeFs();
    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: unpinned.fetchFn,
        fs: fsA.fs,
        decompressZstd: unpinned.decompressZstd,
      }),
    );
    expect(unpinned.calls[0]).toBe(
      `${BASE_URL}/latest/download/firecracker-artifacts-manifest.json`,
    );

    const pinned = scenario();
    const fsB = makeFs();
    await ensureGuestArtifacts(
      {
        kernelPath: KERNEL_PATH,
        rootfsPath: ROOTFS_PATH,
        baseUrl: BASE_URL,
        version: "1.2.3",
        local: false,
      },
      depsFor({
        fetchFn: pinned.fetchFn,
        fs: fsB.fs,
        decompressZstd: pinned.decompressZstd,
      }),
    );
    expect(pinned.calls[0]).toBe(`${BASE_URL}/download/v1.2.3/firecracker-artifacts-manifest.json`);
  });

  it("installs atomically: each file is written to a tmp path then renamed", async () => {
    const s = scenario();
    const { fs, ops } = makeFs();

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    // The kernel is written to a `.tmp-*` sibling and only then renamed
    // onto the final path — never written directly to KERNEL_PATH.
    const kernelWrite = ops.find((o) => o.startsWith(`writeBytes:${KERNEL_PATH}.tmp-`));
    const kernelRename = ops.find((o) => o.startsWith(`rename:${KERNEL_PATH}.tmp-`));
    expect(kernelWrite).toBeDefined();
    expect(kernelRename).toContain(`->${KERNEL_PATH}`);
    expect(ops).not.toContain(`writeBytes:${KERNEL_PATH}`);

    const rootfsRename = ops.find((o) => o.startsWith(`rename:${ROOTFS_PATH}.tmp-`));
    expect(rootfsRename).toContain(`->${ROOTFS_PATH}`);
    // write-then-rename ordering for the kernel.
    expect(ops.indexOf(kernelWrite!)).toBeLessThan(ops.indexOf(kernelRename!));
  });
});

describe("ensureGuestArtifacts — checksum verification", () => {
  it("refuses (fatal) a kernel whose sha256 does not match the manifest", async () => {
    const s = scenario();
    // Corrupt the manifest's expected kernel digest.
    s.manifest.artifacts.x86_64!.vmlinux.sha256 =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const { fs, files } = makeFs();

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(FatalArtifactsError);
    // Nothing installed on a checksum failure.
    expect(files.has(KERNEL_PATH)).toBe(false);
    expect(files.has(ROOTFS_PATH)).toBe(false);
  });

  it("refuses (fatal) a rootfs whose decompressed sha256 does not match", async () => {
    const s = scenario();
    const { fs } = makeFs();

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        // decompressor returns unexpected bytes → sha mismatch
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: () => new Uint8Array([0, 0, 0]),
        }),
      ),
    ).rejects.toThrow(FatalArtifactsError);
  });
});

describe("ensureGuestArtifacts — skip when present", () => {
  it("does not fetch when artifacts exist with a protocol-matching marker and no version pinned", async () => {
    const s = scenario();
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
        signed: true,
      }),
    });

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls).toHaveLength(0);
  });

  it("does not fetch when artifacts exist and the marker matches the pinned version", async () => {
    const s = scenario();
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
        signed: true,
      }),
    });

    await ensureGuestArtifacts(
      {
        kernelPath: KERNEL_PATH,
        rootfsPath: ROOTFS_PATH,
        baseUrl: BASE_URL,
        version: "1.2.3",
        local: false,
      },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls).toHaveLength(0);
  });

  it("re-downloads when the installed marker records a STALE guest protocol (B-4)", async () => {
    // Daemon upgraded in place next to an old rootfs: the skip path must
    // not keep a supervisor that cannot speak this daemon's protocol
    // (e.g. one that ignores `credentials.source: "mmds"` and boots the
    // run without credentials).
    const s = scenario();
    const { fs, files } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION - 1,
      }),
    });

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls.length).toBeGreaterThan(0);
    expect(files.get(KERNEL_PATH)).toEqual(s.kernelBytes);
    expect(JSON.parse(files.get(MARKER_PATH) as string).guest_protocol).toBe(
      GUEST_PROTOCOL_VERSION,
    );
  });

  it("re-downloads when artifacts exist WITHOUT a marker (unverifiable protocol)", async () => {
    const s = scenario();
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
    });

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls.length).toBeGreaterThan(0);
  });

  it("re-verifies when the installed marker predates the signature gate (no `signed` flag)", async () => {
    // A host installed by a pre-signing daemon has a marker with a matching
    // protocol but no `signed: true` — those artifacts were never signature-
    // attested, so the skip fast-path must NOT grandfather them; it re-downloads
    // and re-verifies once, then records `signed: true`.
    const s = scenario();
    const { fs, files } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
      }),
    });

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls.length).toBeGreaterThan(0);
    expect(JSON.parse(files.get(MARKER_PATH) as string).signed).toBe(true);
  });

  it("re-downloads when the pinned version differs from the installed marker", async () => {
    const s = scenario({ version: "2.0.0" });
    const { fs, files } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
      }),
    });

    await ensureGuestArtifacts(
      {
        kernelPath: KERNEL_PATH,
        rootfsPath: ROOTFS_PATH,
        baseUrl: BASE_URL,
        version: "2.0.0",
        local: false,
      },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls.length).toBeGreaterThan(0);
    expect(files.get(KERNEL_PATH)).toEqual(s.kernelBytes);
    expect(JSON.parse(files.get(MARKER_PATH) as string).version).toBe("2.0.0");
  });

  it("is fatal when the signed manifest version does not match the pinned version (rollback)", async () => {
    // Attacker serves an older, validly-signed manifest (version 1.2.3) under a
    // pinned tag of 2.0.0 — the signature verifies, but the version binding must
    // refuse it rather than install known-older artifacts under the newer pin.
    const s = scenario({ version: "1.2.3" });
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
    });

    await expect(
      ensureGuestArtifacts(
        {
          kernelPath: KERNEL_PATH,
          rootfsPath: ROOTFS_PATH,
          baseUrl: BASE_URL,
          version: "2.0.0",
          local: false,
        },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(/version/i);
  });
});

describe("ensureGuestArtifacts — LOCAL opt-out", () => {
  it("skips entirely (no fetch, no fs writes) when local=true", async () => {
    const s = scenario();
    const { fs, ops } = makeFs();

    await ensureGuestArtifacts(
      { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: true },
      depsFor({
        fetchFn: s.fetchFn,
        fs,
        decompressZstd: s.decompressZstd,
      }),
    );

    expect(s.calls).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });
});

describe("ensureGuestArtifacts — protocol mismatch", () => {
  it("is fatal when the manifest guest_protocol differs from the daemon", async () => {
    const s = scenario({ guestProtocol: GUEST_PROTOCOL_VERSION + 1 });
    const { fs, files } = makeFs();

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(FatalArtifactsError);
    expect(files.has(KERNEL_PATH)).toBe(false);
  });

  it("is fatal on protocol mismatch EVEN when artifacts are already present", async () => {
    const s = scenario({ guestProtocol: GUEST_PROTOCOL_VERSION + 1, version: "9.9.9" });
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
    });

    await expect(
      ensureGuestArtifacts(
        {
          kernelPath: KERNEL_PATH,
          rootfsPath: ROOTFS_PATH,
          baseUrl: BASE_URL,
          version: "9.9.9",
          local: false,
        },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(/guest-protocol mismatch/);
  });
});

describe("ensureGuestArtifacts — arch not published", () => {
  it("is fatal when the manifest has no entry for the running arch", async () => {
    const s = scenario({ arch: "x86_64" });
    const { fs } = makeFs();

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
          arch: "aarch64",
        }),
      ),
    ).rejects.toThrow(FatalArtifactsError);
  });
});

describe("ensureGuestArtifacts — manifest signature gate (P1-4)", () => {
  const CONFIG = {
    kernelPath: KERNEL_PATH,
    rootfsPath: ROOTFS_PATH,
    baseUrl: BASE_URL,
    local: false,
  };

  it("is fatal when the release publishes no signature asset — even with usable artifacts on disk", async () => {
    const s = scenario();
    delete s.assets["firecracker-artifacts-manifest.json.sig"];
    // Protocol-compatible artifacts present: the keep-existing network
    // fallback must NOT swallow an unsigned release.
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
      }),
    });

    await expect(
      ensureGuestArtifacts(
        { ...CONFIG, version: "5.0.0" },
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(/refusing to.*trust an unsigned/);
  });

  it("is fatal when the signature does not verify against the pinned key (tampered manifest)", async () => {
    const s = scenario();
    s.assets["firecracker-artifacts-manifest.json.sig"] = {
      text: () => signManifest(s.manifest, WRONG_KEYPAIR.privateKey),
    };
    const { fs, files } = makeFs();

    await expect(
      ensureGuestArtifacts(
        CONFIG,
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
        }),
      ),
    ).rejects.toThrow(/manifest signature is invalid/);
    // Nothing installed from an unverified manifest.
    expect(files.has(KERNEL_PATH)).toBe(false);
    expect(files.has(ROOTFS_PATH)).toBe(false);
  });

  it("is fatal when no signing key is provisioned (placeholder constant, no override)", async () => {
    const savedPubkey = process.env.FIRECRACKER_ARTIFACTS_PUBKEY;
    delete process.env.FIRECRACKER_ARTIFACTS_PUBKEY;
    try {
      const s = scenario();
      const { fs } = makeFs();

      await expect(
        ensureGuestArtifacts(
          CONFIG,
          depsFor({
            fetchFn: s.fetchFn,
            fs,
            decompressZstd: s.decompressZstd,
            manifestPublicKey: undefined,
          }),
        ),
      ).rejects.toThrow(/signing key is not provisioned/);
    } finally {
      if (savedPubkey === undefined) delete process.env.FIRECRACKER_ARTIFACTS_PUBKEY;
      else process.env.FIRECRACKER_ARTIFACTS_PUBKEY = savedPubkey;
    }
  });

  it("resolves the key from FIRECRACKER_ARTIFACTS_PUBKEY when no deps override is given", async () => {
    const savedPubkey = process.env.FIRECRACKER_ARTIFACTS_PUBKEY;
    process.env.FIRECRACKER_ARTIFACTS_PUBKEY = PUBKEY_B64;
    try {
      const s = scenario();
      const { fs, files } = makeFs();

      await ensureGuestArtifacts(
        CONFIG,
        depsFor({
          fetchFn: s.fetchFn,
          fs,
          decompressZstd: s.decompressZstd,
          manifestPublicKey: undefined,
        }),
      );

      expect(files.get(KERNEL_PATH)).toEqual(s.kernelBytes);
    } finally {
      if (savedPubkey === undefined) delete process.env.FIRECRACKER_ARTIFACTS_PUBKEY;
      else process.env.FIRECRACKER_ARTIFACTS_PUBKEY = savedPubkey;
    }
  });
});

describe("ensureGuestArtifacts — network failure policy", () => {
  it("warns and continues when download fails but PROTOCOL-COMPATIBLE artifacts are present", async () => {
    // Marker carries `signed: true` — the keep-existing fallback only applies
    // to installs that already passed the signature gate.
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
        signed: true,
      }),
    });

    // Pinned version forces a download attempt; fetch throws.
    await expect(
      ensureGuestArtifacts(
        {
          kernelPath: KERNEL_PATH,
          rootfsPath: ROOTFS_PATH,
          baseUrl: BASE_URL,
          version: "5.0.0",
          local: false,
        },
        depsFor({ fetchFn: throwingFetch, fs }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does NOT keep a never-signature-verified install through a download failure", async () => {
    // Pre-signing marker (no `signed: true`): the skip path already refuses
    // it, and the keep-existing fallback must refuse it too — otherwise a
    // transient (or attacker-induced) fetch failure boots unverified
    // artifacts on every boot, bypassing the signed-marker gate.
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
      }),
    });

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({ fetchFn: throwingFetch, fs }),
      ),
    ).rejects.toThrow(/without signature verification.*could not be downloaded/);
  });

  it("skips (no download) when a v-prefixed pin matches the marker's v-stripped version", async () => {
    // Operators pin "v1.2.3" (the documented form); the marker records the
    // manifest's v-stripped "1.2.3". The skip comparison must normalize both
    // sides or every daemon boot silently re-downloads kernel+rootfs.
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION,
        signed: true,
      }),
    });

    await expect(
      ensureGuestArtifacts(
        {
          kernelPath: KERNEL_PATH,
          rootfsPath: ROOTFS_PATH,
          baseUrl: BASE_URL,
          version: "v1.2.3",
          local: false,
        },
        // throwingFetch: any download attempt would reject — resolving proves
        // the skip fast-path fired.
        depsFor({ fetchFn: throwingFetch, fs }),
      ),
    ).resolves.toBeUndefined();
  });

  it("does NOT keep a stale-protocol install through a download failure (B-4)", async () => {
    // Present artifacts whose marker records an older protocol: the
    // keep-existing fallback must not resurrect exactly the incompatible
    // state the protocol gate exists to prevent.
    const { fs } = makeFs({
      [KERNEL_PATH]: new Uint8Array([1]),
      [ROOTFS_PATH]: new Uint8Array([2]),
      [MARKER_PATH]: JSON.stringify({
        version: "1.2.3",
        guest_protocol: GUEST_PROTOCOL_VERSION - 1,
      }),
    });

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({ fetchFn: throwingFetch, fs }),
      ),
    ).rejects.toThrow(/incompatible guest protocol.*could not be downloaded/);
  });

  it("is fatal with an actionable message when download fails and nothing is on disk", async () => {
    const { fs } = makeFs();

    await expect(
      ensureGuestArtifacts(
        { kernelPath: KERNEL_PATH, rootfsPath: ROOTFS_PATH, baseUrl: BASE_URL, local: false },
        depsFor({ fetchFn: throwingFetch, fs }),
      ),
    ).rejects.toThrow(/missing and could not be downloaded/);
  });
});
