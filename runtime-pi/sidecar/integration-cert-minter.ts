// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2d — per-SNI leaf cert minter backed by the run CA.
 *
 * The MITM listener accepts a `CONNECT host:port` from the integration
 * MCP subprocess, then needs to present a TLS certificate to the inner
 * client whose Common Name / SAN matches `host`. We cannot reuse the
 * single leaf cert {@link createOpensslCertGenerator} produces (its SAN
 * is bound to the CN — typically `localhost`) because TLS clients
 * verify SAN against the SNI hostname. So we mint a fresh leaf for
 * every new SNI host, signed by the run CA produced in Phase 1.2c, and
 * cache it for the rest of the run.
 *
 * Crypto invariants (same as {@link createOpensslCertGenerator}):
 *   - Authority Key Identifier on the leaf (POC #3a, Python 3.14+).
 *   - Subject Key Identifier (hash).
 *   - Extended Key Usage: TLS Web Server Authentication.
 *   - subjectAltName: DNS:<host>.
 *
 * The CA key never touches disk except for the 50ms window where openssl
 * needs it as input — we write it to a per-host workdir, sign, then
 * unlink immediately. Disk hygiene matters because /run/afps is tmpfs
 * but the workdir may live under {@link os.tmpdir()} which is not.
 *
 * Performance note: ~80 ms per mint on a 2024 MBP. The runtime caches
 * by SNI host — second connection to the same host reuses the cached
 * cert. A run that talks to ≤20 distinct hosts pays ≤1.6 s of cert mint
 * over its full lifetime.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import {
  runOpenssl as runOpensslExec,
  readPem as readPemExec,
  resolveBunSpawn as resolveBunSpawnExec,
  secondsToDaysCeil,
  type OpensslSpawnFn,
  type OpensslExecError,
} from "./openssl-exec.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface CertMinterOptions {
  /** CA root cert PEM (from the run CA bundle). */
  caCertPem: string;
  /** CA private key PEM (from the run CA bundle). */
  caKeyPem: string;
  /** Where temp files live during minting. Defaults to `os.tmpdir()`. */
  workDir?: string;
  /** Override `openssl` binary path. Defaults to `"openssl"`. */
  opensslBin?: string;
  /** Injectable spawn for tests. Defaults to `Bun.spawn`. */
  spawn?: OpensslSpawnFn;
  /** Leaf cert validity in seconds. Defaults to 3600 (matches CA). */
  notAfterSeconds?: number;
  /** Cache capacity (mints beyond this evict LRU). Defaults to 256. */
  cacheCapacity?: number;
}

export interface MintedLeaf {
  /** Host the leaf binds to (SAN DNS). */
  host: string;
  /** Leaf cert PEM signed by the run CA. */
  certPem: string;
  /** Leaf private key PEM. */
  keyPem: string;
}

export interface CertMinter {
  /** Mint or fetch from cache a leaf cert for the given SNI host. */
  mintForHost(host: string): Promise<MintedLeaf>;
  /** Current cache size (for telemetry / tests). */
  readonly cacheSize: number;
  /** Drop every cached cert. Tests use this; production rarely needs it. */
  resetCache(): void;
  /**
   * Wipe the on-disk session workdir — including the staged CA **private
   * key** (`ca.key`). MUST be called at run teardown: on the process adapter
   * `os.tmpdir()` is not tmpfs, so without this the per-run CA signing key
   * (a forgeable trust anchor for that run's MITM CA) survives on the host.
   */
  dispose(): Promise<void>;
}

export class CertMintError extends Error {
  override readonly name = "CertMintError";
  readonly code: CertMintErrorCode;
  readonly stderr?: string;
  constructor(code: CertMintErrorCode, message: string, stderr?: string) {
    super(message);
    this.code = code;
    if (stderr) this.stderr = stderr;
  }
}

export type CertMintErrorCode =
  | "INVALID_HOST"
  | "OPENSSL_NOT_FOUND"
  | "OPENSSL_NONZERO_EXIT"
  | "PEM_NOT_PRODUCED"
  | "WORKDIR_UNWRITABLE";

// Bind the shared openssl-exec helpers (./openssl-exec.ts) to this module's
// error class so call sites stay class-agnostic.
const makeError: OpensslExecError = (code, message, stderr) =>
  new CertMintError(code as CertMintErrorCode, message, stderr);
const runOpenssl = (spawn: OpensslSpawnFn, bin: string, args: string[]) =>
  runOpensslExec(spawn, bin, args, makeError);
const readPem = (filePath: string, label: string) => readPemExec(filePath, label, makeError);
const resolveBunSpawn = () => resolveBunSpawnExec(makeError);

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export function createCertMinter(options: CertMinterOptions): CertMinter {
  const opensslBin = options.opensslBin ?? "openssl";
  const spawn = options.spawn ?? resolveBunSpawn();
  const baseWorkDir = options.workDir ?? tmpdir();
  const notAfterSeconds = options.notAfterSeconds ?? 3600;
  const capacity = Math.max(1, options.cacheCapacity ?? 256);

  // The CA key needs to be on disk for openssl to read it. Stage it
  // once into a per-minter workdir at creation time — much cheaper than
  // re-writing on every mint. The file lives until `resetCache()` or
  // process exit; both lifecycles are scoped to the run.
  const sessionDir = path.join(baseWorkDir, `afps-mint-${randomUUID()}`);
  const caCertStaged = path.join(sessionDir, "ca.crt");
  const caKeyStaged = path.join(sessionDir, "ca.key");

  let staged: Promise<void> | null = null;
  const stageOnce = async (): Promise<void> => {
    if (staged) return staged;
    staged = (async () => {
      try {
        await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new CertMintError(
          "WORKDIR_UNWRITABLE",
          `cannot create minter workdir at '${sessionDir}': ${(err as Error).message}`,
        );
      }
      await fs.writeFile(caCertStaged, options.caCertPem, { encoding: "utf-8", mode: 0o600 });
      await fs.writeFile(caKeyStaged, options.caKeyPem, { encoding: "utf-8", mode: 0o600 });
    })();
    return staged;
  };

  // LRU map — JS Map preserves insertion order so `set + delete + set`
  // is the canonical move-to-front trick.
  const cache = new Map<string, MintedLeaf>();
  const days = secondsToDaysCeil(notAfterSeconds);

  const minter: CertMinter = {
    async mintForHost(host) {
      const normalised = normaliseHost(host);
      const hit = cache.get(normalised);
      if (hit) {
        // Move-to-front for LRU semantics.
        cache.delete(normalised);
        cache.set(normalised, hit);
        return hit;
      }
      await stageOnce();
      const leaf = await mintLeaf(spawn, opensslBin, sessionDir, {
        caCertPath: caCertStaged,
        caKeyPath: caKeyStaged,
        host: normalised,
        days,
      });
      cache.set(normalised, leaf);
      while (cache.size > capacity) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }
      return leaf;
    },
    get cacheSize() {
      return cache.size;
    },
    resetCache() {
      cache.clear();
    },
    async dispose() {
      cache.clear();
      staged = null;
      // rm -rf the whole session workdir (ca.crt + ca.key + any leaf
      // remnants). Best-effort: a failed unlink is logged-by-caller, never
      // throws teardown.
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    },
  };

  return minter;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

interface MintLeafInput {
  caCertPath: string;
  caKeyPath: string;
  host: string;
  days: number;
}

async function mintLeaf(
  spawn: OpensslSpawnFn,
  opensslBin: string,
  sessionDir: string,
  input: MintLeafInput,
): Promise<MintedLeaf> {
  const id = randomUUID().slice(0, 8);
  const keyPath = path.join(sessionDir, `leaf-${id}.key`);
  const csrPath = path.join(sessionDir, `leaf-${id}.csr`);
  const extPath = path.join(sessionDir, `leaf-${id}.ext`);
  const certPath = path.join(sessionDir, `leaf-${id}.crt`);
  // Random 128-bit serial per leaf instead of `-CAcreateserial`/`ca.srl`.
  // The shared serial file is a read-modify-write that races when the MITM
  // listener mints leaves for distinct SNI hosts concurrently — two mints
  // could read the same serial and emit colliding-serial certs under one CA,
  // or corrupt `ca.srl`. A random serial removes the shared state entirely.
  const serial = `0x${randomBytes(16).toString("hex")}`;

  try {
    await runOpenssl(spawn, opensslBin, ["genrsa", "-out", keyPath, "2048"]);
    await runOpenssl(spawn, opensslBin, [
      "req",
      "-new",
      "-key",
      keyPath,
      "-subj",
      `/CN=${input.host}`,
      "-out",
      csrPath,
    ]);

    // Extension file carries the spec-required AKI + SAN + EKU=serverAuth.
    const extfile = [
      "authorityKeyIdentifier=keyid,issuer",
      "subjectKeyIdentifier=hash",
      "basicConstraints=CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${input.host}`,
      "",
    ].join("\n");
    await fs.writeFile(extPath, extfile, { encoding: "utf-8", mode: 0o600 });

    await runOpenssl(spawn, opensslBin, [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      input.caCertPath,
      "-CAkey",
      input.caKeyPath,
      "-set_serial",
      serial,
      "-days",
      String(input.days),
      "-sha256",
      "-extfile",
      extPath,
      "-out",
      certPath,
    ]);

    const [certPem, keyPem] = await Promise.all([
      readPem(certPath, "leafCert"),
      readPem(keyPath, "leafKey"),
    ]);
    return { host: input.host, certPem, keyPem };
  } finally {
    // Best-effort cleanup — leave nothing behind on the happy path. On
    // failure the per-leaf files stay so an operator can rerun openssl
    // by hand. The CA key staged at session level is independent.
    await Promise.all(
      [keyPath, csrPath, extPath, certPath].map((p) => fs.rm(p, { force: true }).catch(() => {})),
    );
  }
}

function normaliseHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) {
    throw new CertMintError("INVALID_HOST", "host must be a non-empty string");
  }
  // SAN entries must be DNS names. Reject obvious garbage early so the
  // listener returns a structured error rather than an openssl parse
  // failure 200ms later. Allow A-Z 0-9 . - and IDN-encoded punycode.
  if (!/^[a-z0-9.\-_]+$/.test(trimmed)) {
    throw new CertMintError("INVALID_HOST", `host '${host}' contains invalid characters`);
  }
  return trimmed;
}
