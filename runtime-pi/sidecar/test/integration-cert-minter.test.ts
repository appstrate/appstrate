// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-SNI cert minter. Hits real openssl so the cert
 * actually parses and verifies against the run CA — skipped when
 * openssl is unavailable.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createOpensslCertGenerator } from "../ca-cert-openssl.ts";
import { createCertMinter, CertMintError } from "../integration-cert-minter.ts";

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

const HAS_OPENSSL = await opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[integration-cert-minter] openssl not present — subprocess tests skipped");
}
const runIfOpenssl: typeof it = HAS_OPENSSL ? it : (it.skip as unknown as typeof it);

async function makeRunCa(): Promise<{ caCertPem: string; caKeyPem: string }> {
  const workDir = path.join(tmpdir(), `afps-mint-test-ca-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const gen = createOpensslCertGenerator({ workDir });
  const out = await gen({
    runId: "mint-test",
    serverCommonName: "localhost",
    requiresAki: true,
    notAfterSeconds: 3600,
  });
  return { caCertPem: out.caCertPem, caKeyPem: out.caKeyPem };
}

async function dumpCert(pem: string): Promise<string> {
  const file = path.join(tmpdir(), `afps-mint-dump-${randomUUID()}.pem`);
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

async function verifyAgainst(caPem: string, leafPem: string): Promise<number> {
  const dir = path.join(tmpdir(), `afps-mint-verify-${randomUUID()}`);
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

describe("createCertMinter — host validation", () => {
  it("rejects empty host without spawning openssl", async () => {
    const minter = createCertMinter({
      caCertPem: "ignored",
      caKeyPem: "ignored",
      // Stub spawn — should never be called.
      spawn: () => {
        throw new Error("spawn should not be invoked for invalid input");
      },
    });
    let caught: unknown;
    try {
      await minter.mintForHost("   ");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CertMintError);
    expect((caught as CertMintError).code).toBe("INVALID_HOST");
  });

  it("rejects hosts with control characters", async () => {
    const minter = createCertMinter({
      caCertPem: "ignored",
      caKeyPem: "ignored",
      spawn: () => {
        throw new Error("unreachable");
      },
    });
    let caught: unknown;
    try {
      await minter.mintForHost("api.example.com/x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CertMintError);
    expect((caught as CertMintError).code).toBe("INVALID_HOST");
  });
});

describe("createCertMinter — mint + cache", () => {
  runIfOpenssl("mints a leaf whose SAN binds the requested host", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({ caCertPem: ca.caCertPem, caKeyPem: ca.caKeyPem });
    const leaf = await minter.mintForHost("api.example.com");
    expect(leaf.host).toBe("api.example.com");
    expect(leaf.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(leaf.keyPem).toMatch(/-----BEGIN (?:RSA )?PRIVATE KEY-----/);
    const dump = await dumpCert(leaf.certPem);
    expect(dump).toMatch(/DNS:api\.example\.com/);
    expect(dump).toMatch(/X509v3 Authority Key Identifier/);
    expect(dump).toMatch(/X509v3 Subject Key Identifier/);
    expect(dump).toMatch(/TLS Web Server Authentication/);
  });

  runIfOpenssl("leaf cert verifies against the run CA", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({ caCertPem: ca.caCertPem, caKeyPem: ca.caKeyPem });
    const leaf = await minter.mintForHost("api.example.com");
    expect(await verifyAgainst(ca.caCertPem, leaf.certPem)).toBe(0);
  });

  runIfOpenssl("cache hit returns the same leaf object", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({ caCertPem: ca.caCertPem, caKeyPem: ca.caKeyPem });
    const a = await minter.mintForHost("api.example.com");
    const b = await minter.mintForHost("api.example.com");
    expect(a).toBe(b);
    expect(minter.cacheSize).toBe(1);
  });

  runIfOpenssl("host casing normalises (cache hit on different casing)", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({ caCertPem: ca.caCertPem, caKeyPem: ca.caKeyPem });
    const a = await minter.mintForHost("API.Example.COM");
    const b = await minter.mintForHost("api.example.com");
    expect(a).toBe(b);
  });

  runIfOpenssl("LRU evicts beyond capacity", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({
      caCertPem: ca.caCertPem,
      caKeyPem: ca.caKeyPem,
      cacheCapacity: 2,
    });
    await minter.mintForHost("a.example.com");
    await minter.mintForHost("b.example.com");
    await minter.mintForHost("c.example.com");
    expect(minter.cacheSize).toBe(2);
    // `a` was oldest and should be gone; refetching mints fresh.
    const aBefore = await minter.mintForHost("a.example.com");
    const aAgain = await minter.mintForHost("a.example.com");
    expect(aBefore).toBe(aAgain);
    expect(minter.cacheSize).toBe(2);
  });

  runIfOpenssl("resetCache clears every host", async () => {
    const ca = await makeRunCa();
    const minter = createCertMinter({ caCertPem: ca.caCertPem, caKeyPem: ca.caKeyPem });
    await minter.mintForHost("a.example.com");
    await minter.mintForHost("b.example.com");
    expect(minter.cacheSize).toBe(2);
    minter.resetCache();
    expect(minter.cacheSize).toBe(0);
  });
});
