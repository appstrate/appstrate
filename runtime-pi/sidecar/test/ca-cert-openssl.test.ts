// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the openssl-backed CertGenerator.
 *
 * Hits the real `openssl` binary (the runtime ships it on Linux + Mac
 * dev hosts; CI must too). Verifies:
 *   - The leaf carries the Authority Key Identifier extension (the
 *     spec-required invariant the planner enforces).
 *   - The leaf's SAN includes the requested CN + extra SANs.
 *   - The chain verifies against itself (`openssl verify`).
 *   - PEM markers are present on every output (planner enforces this
 *     but we test our end too).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createOpensslCertGenerator, OpensslCaGeneratorError } from "../ca-cert-openssl.ts";

async function opensslAvailable(): Promise<boolean> {
  try {
    const proc = (
      globalThis as unknown as {
        Bun?: { spawn: (args: string[], opts: object) => { exited: Promise<number> } };
      }
    ).Bun?.spawn(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    if (!proc) return false;
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// Top-level await — Bun supports it in test files. This way `describe`
// can pick the right `it` variant *before* the test tree is registered.
const HAS_OPENSSL = await opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[ca-cert-openssl] openssl not present — subprocess tests will be skipped");
}
const runIfOpenssl: typeof it = HAS_OPENSSL ? it : (it.skip as unknown as typeof it);

async function genBundle(extraSans: readonly string[] = []) {
  const workDir = path.join(tmpdir(), `afps-ca-test-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const gen = createOpensslCertGenerator({ workDir });
  const out = await gen({
    runId: "run-test",
    serverCommonName: "localhost",
    serverSans: extraSans,
    requiresAki: true,
    notAfterSeconds: 3600,
  });
  return { out, workDir };
}

async function opensslDump(pem: string): Promise<string> {
  const file = path.join(tmpdir(), `afps-dump-${randomUUID()}.pem`);
  await fs.writeFile(file, pem, "utf-8");
  try {
    const proc = (
      globalThis as unknown as {
        Bun?: {
          spawn: (
            args: string[],
            opts: object,
          ) => { exited: Promise<number>; stdout: ReadableStream<Uint8Array> };
        };
      }
    ).Bun?.spawn(["openssl", "x509", "-in", file, "-noout", "-text"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!proc) throw new Error("openssl missing");
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    await proc.exited;
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(all);
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

async function opensslVerify(caPem: string, leafPem: string): Promise<number> {
  const dir = path.join(tmpdir(), `afps-verify-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const caFile = path.join(dir, "ca.pem");
  const leafFile = path.join(dir, "leaf.pem");
  try {
    await fs.writeFile(caFile, caPem, "utf-8");
    await fs.writeFile(leafFile, leafPem, "utf-8");
    const proc = (
      globalThis as unknown as {
        Bun?: { spawn: (args: string[], opts: object) => { exited: Promise<number> } };
      }
    ).Bun?.spawn(["openssl", "verify", "-CAfile", caFile, leafFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!proc) return -1;
    return await proc.exited;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("createOpensslCertGenerator — PEM contract", () => {
  runIfOpenssl("emits all four PEMs with correct markers", async () => {
    const { out } = await genBundle();
    expect(out.caCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(out.caCertPem).toMatch(/-----END CERTIFICATE-----/);
    expect(out.caKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----|-----BEGIN RSA PRIVATE KEY-----/);
    expect(out.serverCertPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(out.serverKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----|-----BEGIN RSA PRIVATE KEY-----/);
  });
});

describe("createOpensslCertGenerator — AKI is mandatory (spec §5.4.1)", () => {
  runIfOpenssl("leaf cert carries the Authority Key Identifier extension", async () => {
    const { out } = await genBundle();
    const dump = await opensslDump(out.serverCertPem);
    expect(dump).toMatch(/X509v3 Authority Key Identifier/);
    expect(dump).toMatch(/X509v3 Subject Key Identifier/);
    expect(dump).toMatch(/Extended Key Usage:[\s\S]*?TLS Web Server Authentication/);
  });

  it("rejects generation when caller falsifies requiresAki", async () => {
    const gen = createOpensslCertGenerator();
    let caught: unknown;
    try {
      await gen({
        runId: "x",
        serverCommonName: "localhost",
        // @ts-expect-error — testing runtime guard against a stub generator
        requiresAki: false,
        notAfterSeconds: 60,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpensslCaGeneratorError);
    expect((caught as OpensslCaGeneratorError).code).toBe("AKI_NOT_REQUESTED");
  });
});

describe("createOpensslCertGenerator — SAN binding", () => {
  runIfOpenssl("SAN includes CN + every extra host requested", async () => {
    const { out } = await genBundle(["api.example.com", "alt.example.com"]);
    const dump = await opensslDump(out.serverCertPem);
    expect(dump).toMatch(/DNS:localhost/);
    expect(dump).toMatch(/DNS:api\.example\.com/);
    expect(dump).toMatch(/DNS:alt\.example\.com/);
  });

  runIfOpenssl("dedupes SAN entries case-insensitively", async () => {
    const { out } = await genBundle(["LOCALHOST", "localhost", "api.example.com"]);
    const dump = await opensslDump(out.serverCertPem);
    // localhost should appear in SAN exactly once (the X509v3 dump
    // section, not the issuer or other places).
    const sanBlock = dump.match(/X509v3 Subject Alternative Name:\s*\n\s*([^\n]+)/);
    expect(sanBlock).not.toBeNull();
    const sanLine = sanBlock![1]!.toLowerCase();
    const matches = sanLine.match(/dns:localhost(?:[,\s]|$)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("createOpensslCertGenerator — chain validates", () => {
  runIfOpenssl("openssl verify succeeds against the generated CA", async () => {
    const { out } = await genBundle();
    const code = await opensslVerify(out.caCertPem, out.serverCertPem);
    expect(code).toBe(0);
  });
});

describe("createOpensslCertGenerator — cleanup", () => {
  runIfOpenssl("removes the workdir on success", async () => {
    const workDir = path.join(tmpdir(), `afps-ca-cleanup-${randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });
    const gen = createOpensslCertGenerator({ workDir });
    await gen({
      runId: "cleanup",
      serverCommonName: "localhost",
      requiresAki: true,
      notAfterSeconds: 60,
    });
    // Inspect the parent workDir — the per-session subdir (afps-ca-*)
    // should be gone, leaving the parent empty.
    const entries = await fs.readdir(workDir);
    expect(entries).toEqual([]);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  });
});
