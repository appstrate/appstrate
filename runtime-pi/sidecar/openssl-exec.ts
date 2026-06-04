// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared openssl-CLI execution helpers for the per-run CA generator
 * ({@link ./ca-cert-openssl.ts}) and the per-SNI leaf minter
 * ({@link ./integration-cert-minter.ts}).
 *
 * Both drive `openssl` via `Bun.spawn`, collect stderr, read PEM output,
 * and convert a TTL to a `-days` count. The only thing that differs is the
 * error class each throws, so callers pass an {@link OpensslExecError}
 * factory and these helpers stay class-agnostic.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Spawn signature compatible with `Bun.spawn` (the only fields these helpers use). */
export type OpensslSpawnFn = (
  cmd: string[],
  opts: {
    stdin?: "ignore" | "pipe";
    stdout: "pipe";
    stderr: "pipe";
    cwd?: string;
  },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

/**
 * Error factory the caller supplies so a failure surfaces as the caller's
 * own error class. `code` is one of the openssl-exec failure codes
 * (`OPENSSL_NOT_FOUND` | `OPENSSL_NONZERO_EXIT` | `PEM_NOT_PRODUCED`), which
 * both `OpensslCaErrorCode` and `CertMintErrorCode` include.
 */
export type OpensslExecError = (code: string, message: string, stderr?: string) => Error;

/** Run `openssl <args>`; throw (via `makeError`) on spawn failure or non-zero exit. */
export async function runOpenssl(
  spawn: OpensslSpawnFn,
  bin: string,
  args: string[],
  makeError: OpensslExecError,
): Promise<void> {
  let proc: ReturnType<OpensslSpawnFn>;
  try {
    proc = spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw makeError("OPENSSL_NOT_FOUND", `failed to spawn '${bin}': ${(err as Error).message}`);
  }
  const stderrText = await collectStream(proc.stderr);
  const code = await proc.exited;
  if (code !== 0) {
    throw makeError(
      "OPENSSL_NONZERO_EXIT",
      `'${bin} ${args.slice(0, 2).join(" ")}' exited ${code}`,
      stderrText,
    );
  }
}

/** Drain a byte stream to a UTF-8 string, swallowing read errors. */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    // ignore
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Read a PEM file openssl was expected to produce; throw (via `makeError`) if missing/empty. */
export async function readPem(
  filePath: string,
  label: string,
  makeError: OpensslExecError,
): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    throw makeError(
      "PEM_NOT_PRODUCED",
      `expected ${label} at '${filePath}': ${(err as Error).message}`,
    );
  }
  if (raw.length === 0) {
    throw makeError("PEM_NOT_PRODUCED", `${label} is empty`);
  }
  return raw;
}

/**
 * openssl `-days` takes an integer day count. Round up so a sub-day window
 * (e.g. 3600s) doesn't collapse to "0 days" (which openssl rejects); 1 day
 * minimum.
 */
export function secondsToDaysCeil(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 86_400));
}

/** Resolve `Bun.spawn`; throw (via `makeError`) when not running under Bun. */
export function resolveBunSpawn(makeError: OpensslExecError): OpensslSpawnFn {
  const fn = (globalThis as unknown as { Bun?: { spawn?: unknown } }).Bun?.spawn as
    | OpensslSpawnFn
    | undefined;
  if (!fn) {
    throw makeError(
      "OPENSSL_NOT_FOUND",
      "Bun.spawn is not available — openssl operations require the Bun runtime",
    );
  }
  return fn;
}

/**
 * How the leaf's serial number is assigned. The per-run CA leaf uses
 * `-CAcreateserial` (a `ca.srl` file alongside the CA cert); the per-SNI
 * minter passes an explicit random serial via `-set_serial` to avoid the
 * shared-serial-file race when minting concurrently under one CA.
 */
export type LeafSerial =
  | { mode: "createserial"; serialPath: string }
  | { mode: "set"; value: string };

/** Parameters for {@link mintLeafCert}. Captures the two sites' intentional differences. */
export interface MintLeafCertParams {
  /** Spawn used to drive `openssl` (injectable for tests). */
  spawn: OpensslSpawnFn;
  /** `openssl` binary path. */
  bin: string;
  /** Directory the temp key/CSR/extfile/cert are written into. */
  workDir: string;
  /** Leaf subject Common Name (`/CN=…`). */
  cn: string;
  /**
   * SAN DNS entries (deduped case-insensitively, blanks dropped). The CA-leaf
   * site passes `[cn, ...extraSans]`; the SNI minter passes `[host]`.
   */
  sans: string[];
  /** `-days` validity (already converted from a TTL via {@link secondsToDaysCeil}). */
  days: number;
  /** Signing CA cert PEM path. */
  caCertPath: string;
  /** Signing CA private-key PEM path. */
  caKeyPath: string;
  /** Serial-assignment strategy (discriminated). */
  serial: LeafSerial;
  /** Output paths for the generated leaf key + cert. */
  keyPath: string;
  certPath: string;
  /** Caller's error factory so failures surface as the caller's own error class. */
  makeError: OpensslExecError;
}

/** Result of {@link mintLeafCert}: the leaf key + cert PEMs. */
export interface MintLeafCertResult {
  keyPem: string;
  certPem: string;
}

/**
 * Generate a 2048-bit RSA leaf certificate signed by the given CA:
 * `genrsa` → CSR (`req -new`) → write the X.509 v3 extension file
 * (AKI/SKI/`CA:FALSE`/keyUsage/EKU=serverAuth/SAN) → sign (`x509 -req`).
 *
 * Shared by the per-run CA leaf ({@link ../ca-cert-openssl.ts}) and the
 * per-SNI MITM leaf ({@link ../integration-cert-minter.ts}). The extension
 * block is byte-identical at both sites — only the SAN value and the serial
 * strategy differ, both captured as params.
 *
 * Temp CSR + extfile are written under `workDir` and cleaned up on the way
 * out (best-effort). The key + cert files are left for the caller to read.
 */
export async function mintLeafCert(params: MintLeafCertParams): Promise<MintLeafCertResult> {
  const {
    spawn,
    bin,
    workDir,
    cn,
    sans,
    days,
    caCertPath,
    caKeyPath,
    serial,
    keyPath,
    certPath,
    makeError,
  } = params;

  const id = randomUUID().slice(0, 8);
  const csrPath = path.join(workDir, `mint-${id}.csr`);
  const extPath = path.join(workDir, `mint-${id}.ext`);

  const run = (args: string[]) => runOpenssl(spawn, bin, args, makeError);

  try {
    await run(["genrsa", "-out", keyPath, "2048"]);
    await run(["req", "-new", "-key", keyPath, "-subj", `/CN=${cn}`, "-out", csrPath]);

    const extfile = [
      "authorityKeyIdentifier=keyid,issuer",
      "subjectKeyIdentifier=hash",
      "basicConstraints=CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${buildSanLine(sans)}`,
      "",
    ].join("\n");
    await fs.writeFile(extPath, extfile, { encoding: "utf-8", mode: 0o600 });

    const serialArgs =
      serial.mode === "createserial"
        ? ["-CAcreateserial", "-CAserial", serial.serialPath]
        : ["-set_serial", serial.value];

    await run([
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      ...serialArgs,
      "-days",
      String(days),
      "-sha256",
      "-extfile",
      extPath,
      "-out",
      certPath,
    ]);

    const [keyPem, certPem] = await Promise.all([
      readPem(keyPath, "leafKey", makeError),
      readPem(certPath, "leafCert", makeError),
    ]);
    return { keyPem, certPem };
  } finally {
    // Best-effort: drop the transient CSR + extfile. Key + cert are the
    // caller's to manage (read then clean up at their own layer).
    await Promise.all([csrPath, extPath].map((p) => fs.rm(p, { force: true }).catch(() => {})));
  }
}

/**
 * Build the `subjectAltName` value passed to openssl. Entries are deduped
 * (case-insensitive) and blanks dropped so the leaf cert stays compact:
 * `["localhost","API.example.com"] → "DNS:localhost,DNS:API.example.com"`.
 */
function buildSanLine(hosts: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of hosts) {
    const trimmed = host.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`DNS:${trimmed}`);
  }
  return out.join(",");
}
