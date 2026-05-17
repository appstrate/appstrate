// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2a — per-run CA + tmpfs planner for the HTTPS credential
 * proxy (proposal §5.4.1).
 *
 * Pure planner: given the orchestrator-supplied `runId` + an injectable
 * cert generator, returns the {@link CaBundle} (PEMs + tmpfs paths) the
 * sidecar mounts into the integration's filesystem. Actual X.509
 * encoding is delegated to the injected {@link CertGenerator} so this
 * module stays runtime-agnostic — `runtime-pi` ships the real
 * `Bun.spawn("openssl", …)` or `node-forge` implementation.
 *
 * Why this lives in connect: the CA bundle is the same object the
 * credential-proxy + integration-runtime + dashboard preview ("what
 * env will my subprocess get?") all consume. Centralising the path +
 * permission policy (POSIX `0444` per spec) here keeps the three
 * consumers from drifting.
 *
 * Critical crypto invariant (validated POC #3a):
 *   the leaf server cert MUST carry the Authority Key Identifier (AKI)
 *   extension. Python 3.14+ with OpenSSL 3.6+ rejects leaf certs
 *   without AKI even when the chain is otherwise valid. The injected
 *   generator implementation is required to set AKI; this planner
 *   exposes a `requiresAki: true` flag the generator can assert on.
 */

import { isValidVersion } from "@appstrate/core/semver";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/**
 * Generated CA root + leaf cert pair. Keys stay in memory; the runtime
 * never persists them.
 */
export interface CaGenerationOutput {
  caCertPem: string;
  caKeyPem: string;
  serverCertPem: string;
  serverKeyPem: string;
}

/** Spec hint passed to the injected generator — drives AKI emission. */
export interface CaGenerationRequest {
  /** Stable run id — used as CN to ease debugging across logs. */
  runId: string;
  /** CommonName for the server cert (typically `"localhost"`). */
  serverCommonName: string;
  /** Optional SANs (DNS) the server cert should bind beyond the CN. */
  serverSans?: readonly string[];
  /** True (always) — generator must include AKI on the leaf. */
  requiresAki: true;
  /** Validity window in seconds. Defaults to 1h — matches max run duration. */
  notAfterSeconds: number;
}

/** Pluggable encoder. Tests inject a stub; runtime-pi wires openssl/forge. */
export type CertGenerator = (req: CaGenerationRequest) => Promise<CaGenerationOutput>;

/** Final bundle handed to the sidecar mount layer. */
export interface CaBundle {
  runId: string;
  /** Where the runtime writes the CA root cert (mode `0444`). */
  caCertPath: string;
  /** Where the runtime writes the leaf server cert/key (mode `0400`). */
  serverCertPath: string;
  serverKeyPath: string;
  /** Memory-only PEMs — never persisted. The orchestrator passes them around. */
  pems: CaGenerationOutput;
  /** UNIX permissions to apply on each file (4-digit octal). */
  modes: {
    caCert: "0444";
    serverCert: "0400";
    serverKey: "0400";
  };
  /** Absolute tmpfs root the bundle was planned against. */
  tmpfsRoot: string;
  /** ISO-8601 timestamp the bundle expires (informational). */
  notAfter: string;
  /** When the bundle was planned (informational). */
  generatedAt: string;
}

export interface PlanCaBundleOptions {
  runId: string;
  /** Absolute tmpfs path the proxy mount uses (default `/run/afps`). */
  tmpfsRoot?: string;
  /** CommonName for the leaf cert. Defaults to `"localhost"`. */
  serverCommonName?: string;
  /** Additional SANs to bind on the leaf cert. */
  serverSans?: readonly string[];
  /** Cert validity in seconds (default 3600 = 1h max run). */
  notAfterSeconds?: number;
  /** Injectable generator. Production caller wires the real openssl impl. */
  generator: CertGenerator;
  /** Injectable clock for `generatedAt`/`notAfter`. */
  now?: () => Date;
}

/**
 * Plan a per-run CA bundle. Calls the injected generator, then composes
 * the tmpfs paths + permission modes spec §5.4.1 requires.
 *
 * Throws when:
 *   - `runId` is empty (defensive — CA paths embed it).
 *   - The generator returns malformed PEMs (`-----BEGIN` markers
 *     missing).
 */
export async function planCaBundle(options: PlanCaBundleOptions): Promise<CaBundle> {
  if (!options.runId || /[\s/]/.test(options.runId)) {
    throw new Error(
      `planCaBundle: runId must be a non-empty path-safe string (got '${options.runId}')`,
    );
  }
  // Strip trailing slashes without a polynomial regex (CodeQL js/redos):
  // walk back manually so a pathological `////…` input is linear in length.
  const rawTmpfs = options.tmpfsRoot ?? "/run/afps";
  let trimEnd = rawTmpfs.length;
  while (trimEnd > 0 && rawTmpfs.charCodeAt(trimEnd - 1) === 47 /* '/' */) trimEnd -= 1;
  const tmpfsRoot = rawTmpfs.slice(0, trimEnd);
  const serverCommonName = options.serverCommonName ?? "localhost";
  const notAfterSeconds = options.notAfterSeconds ?? 3600;
  const now = (options.now ?? (() => new Date()))();
  const notAfter = new Date(now.getTime() + notAfterSeconds * 1000);

  const req: CaGenerationRequest = {
    runId: options.runId,
    serverCommonName,
    ...(options.serverSans ? { serverSans: options.serverSans } : {}),
    requiresAki: true,
    notAfterSeconds,
  };

  const pems = await options.generator(req);
  assertPem(pems.caCertPem, "caCertPem", "CERTIFICATE");
  assertPem(pems.caKeyPem, "caKeyPem", "PRIVATE KEY");
  assertPem(pems.serverCertPem, "serverCertPem", "CERTIFICATE");
  assertPem(pems.serverKeyPem, "serverKeyPem", "PRIVATE KEY");

  return {
    runId: options.runId,
    caCertPath: `${tmpfsRoot}/ca.pem`,
    serverCertPath: `${tmpfsRoot}/server.crt`,
    serverKeyPath: `${tmpfsRoot}/server.key`,
    pems,
    modes: { caCert: "0444", serverCert: "0400", serverKey: "0400" },
    tmpfsRoot,
    notAfter: notAfter.toISOString(),
    generatedAt: now.toISOString(),
  };
}

// ─────────────────────────────────────────────
// Mount plan — emitted alongside the bundle so the sidecar wires the
// same tmpfs structure deterministically.
// ─────────────────────────────────────────────

export interface FsWriteEntry {
  path: string;
  /** UTF-8 content (PEM). */
  content: string;
  /** 4-digit octal mode string. */
  mode: string;
}

/** Flatten the bundle into a series of fs.write operations the sidecar replays. */
export function bundleToFsWrites(bundle: CaBundle): FsWriteEntry[] {
  return [
    { path: bundle.caCertPath, content: bundle.pems.caCertPem, mode: bundle.modes.caCert },
    {
      path: bundle.serverCertPath,
      content: bundle.pems.serverCertPem,
      mode: bundle.modes.serverCert,
    },
    { path: bundle.serverKeyPath, content: bundle.pems.serverKeyPem, mode: bundle.modes.serverKey },
  ];
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function assertPem(value: string, fieldName: string, kind: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`planCaBundle: ${fieldName} is missing`);
  }
  if (!value.includes(`-----BEGIN ${kind}-----`)) {
    throw new Error(`planCaBundle: ${fieldName} is missing the '-----BEGIN ${kind}-----' marker`);
  }
}

/**
 * Public helper for cert-generator implementations to advertise an
 * implementation tag (e.g. `"openssl-3.5.0"`, `"node-forge-1.3.1"`)
 * the platform records in audit logs. Validated against semver to
 * keep parsing simple.
 */
export function makeGeneratorIdentity(tool: string, version: string): string {
  if (!isValidVersion(version)) {
    throw new Error(`makeGeneratorIdentity: '${version}' is not a valid semver`);
  }
  return `${tool}-${version}`;
}
