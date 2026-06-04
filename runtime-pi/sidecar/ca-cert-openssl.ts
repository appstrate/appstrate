// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2c — real X.509 generator backed by the system `openssl` CLI.
 *
 * Implements the {@link CertGenerator} contract exposed by
 * `@appstrate/connect/proxy-ca-planner`. Generates:
 *
 *   - a 2048-bit RSA root CA self-signed with the v3 extensions a
 *     standards-compliant verifier expects (`basicConstraints CA:TRUE`,
 *     `keyUsage cRLSign,keyCertSign`, `subjectKeyIdentifier=hash`),
 *   - a 2048-bit RSA leaf signed by the root, **carrying AKI**
 *     (`authorityKeyIdentifier=keyid,issuer`), `subjectKeyIdentifier=hash`,
 *     `extendedKeyUsage=serverAuth`, and `subjectAltName` for every host
 *     the caller requested.
 *
 * Why AKI is load-bearing: Python 3.14 / OpenSSL 3.6 reject leaf certs
 * without AKI even when the chain otherwise validates (proposal §5.4.1,
 * POC #3a). The planner enforces `requiresAki: true` in its request —
 * we assert on it here so a stub generator can't silently disable it.
 *
 * Why openssl-CLI and not a pure-JS library: pulling `node-forge` (or
 * any X.509 lib) into the sidecar bundle adds ~500 KB and a wide
 * attack-surface dep. The runtime already ships openssl (every Linux
 * container has it; macOS dev hosts too). The downside is process spawn
 * overhead — a per-run cost of ~80 ms total for 4 openssl invocations,
 * acceptable for once-per-run.
 *
 * Boundaries:
 *   - Temp files live under {@link OpensslGeneratorOptions.workDir} and
 *     are deleted on success. On failure we leave them for diagnostics
 *     and surface a structured error code.
 *   - The CA key never leaves memory longer than necessary — the file
 *     is unlinked the moment the leaf is signed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  CaGenerationOutput,
  CaGenerationRequest,
  CertGenerator,
} from "@appstrate/connect/proxy-ca-planner";
import {
  runOpenssl as runOpensslExec,
  readPem as readPemExec,
  resolveBunSpawn as resolveBunSpawnExec,
  secondsToDaysCeil,
  mintLeafCert,
  type OpensslSpawnFn,
  type OpensslExecError,
} from "./openssl-exec.ts";

export type { OpensslSpawnFn } from "./openssl-exec.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface OpensslGeneratorOptions {
  /** Where the generator writes its temp files. Defaults to `os.tmpdir()`. */
  workDir?: string;
  /** Override the `openssl` binary path. Defaults to `"openssl"`. */
  opensslBin?: string;
  /** Injectable spawn for tests. Defaults to `Bun.spawn`. */
  spawn?: OpensslSpawnFn;
}

export class OpensslCaGeneratorError extends Error {
  override readonly name = "OpensslCaGeneratorError";
  readonly code: OpensslCaErrorCode;
  readonly stderr?: string;
  constructor(code: OpensslCaErrorCode, message: string, stderr?: string) {
    super(message);
    this.code = code;
    if (stderr) this.stderr = stderr;
  }
}

export type OpensslCaErrorCode =
  | "OPENSSL_NOT_FOUND"
  | "OPENSSL_NONZERO_EXIT"
  | "AKI_NOT_REQUESTED"
  | "WORKDIR_UNWRITABLE"
  | "PEM_NOT_PRODUCED";

// Bind the shared openssl-exec helpers (./openssl-exec.ts) to this module's
// error class so call sites stay class-agnostic.
const makeError: OpensslExecError = (code, message, stderr) =>
  new OpensslCaGeneratorError(code as OpensslCaErrorCode, message, stderr);
const runOpenssl = (spawn: OpensslSpawnFn, bin: string, args: string[]) =>
  runOpensslExec(spawn, bin, args, makeError);
const readPem = (filePath: string, label: string) => readPemExec(filePath, label, makeError);
const resolveBunSpawn = () => resolveBunSpawnExec(makeError);

/**
 * Build a {@link CertGenerator} bound to the system openssl. The returned
 * function can be passed straight to `planCaBundle({generator: …})`.
 */
export function createOpensslCertGenerator(options: OpensslGeneratorOptions = {}): CertGenerator {
  const opensslBin = options.opensslBin ?? "openssl";
  const spawn = options.spawn ?? resolveBunSpawn();
  const baseWorkDir = options.workDir ?? tmpdir();

  return async (req: CaGenerationRequest): Promise<CaGenerationOutput> => {
    // Defence in depth — the planner enforces this on its end too.
    if (req.requiresAki !== true) {
      throw new OpensslCaGeneratorError(
        "AKI_NOT_REQUESTED",
        "openssl CertGenerator refuses to emit a leaf without AKI",
      );
    }

    const session = path.join(baseWorkDir, `afps-ca-${randomUUID()}`);
    try {
      await fs.mkdir(session, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new OpensslCaGeneratorError(
        "WORKDIR_UNWRITABLE",
        `cannot create openssl workdir at '${session}': ${(err as Error).message}`,
      );
    }

    const caKeyPath = path.join(session, "ca.key");
    const caCertPath = path.join(session, "ca.crt");
    const serverKeyPath = path.join(session, "server.key");
    const serverCertPath = path.join(session, "server.crt");
    const serialPath = path.join(session, "ca.srl");

    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      // Best-effort: remove everything regardless of individual failures.
      await fs.rm(session, { recursive: true, force: true }).catch(() => {});
    };

    try {
      const days = secondsToDaysCeil(req.notAfterSeconds);

      // ─── Root CA ───
      await runOpenssl(spawn, opensslBin, ["genrsa", "-out", caKeyPath, "2048"]);
      await runOpenssl(spawn, opensslBin, [
        "req",
        "-new",
        "-x509",
        "-nodes",
        "-key",
        caKeyPath,
        "-sha256",
        "-days",
        String(days),
        "-subj",
        `/CN=Appstrate Run CA (${req.runId})`,
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext",
        "keyUsage=critical,cRLSign,keyCertSign",
        "-addext",
        "subjectKeyIdentifier=hash",
        "-out",
        caCertPath,
      ]);

      // ─── Leaf key + CSR + ext file + sign (AKI mandatory) ───
      const { keyPem: serverKeyPem, certPem: serverCertPem } = await mintLeafCert({
        spawn,
        bin: opensslBin,
        workDir: session,
        cn: req.serverCommonName,
        sans: [req.serverCommonName, ...(req.serverSans ?? [])],
        days,
        caCertPath,
        caKeyPath,
        serial: { mode: "createserial", serialPath },
        keyPath: serverKeyPath,
        certPath: serverCertPath,
        makeError,
      });

      const [caCertPem, caKeyPem] = await Promise.all([
        readPem(caCertPath, "caCertPem"),
        readPem(caKeyPath, "caKeyPem"),
      ]);

      return { caCertPem, caKeyPem, serverCertPem, serverKeyPem };
    } finally {
      await cleanup();
    }
  };
}
