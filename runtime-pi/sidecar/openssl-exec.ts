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
