// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  encodePairingToken,
  decodePairingToken,
  hashPairingSecret,
} from "@appstrate/core/pairing-token";

const VALID_SECRET = "abcd_efgh-IJKL_mnop-qrstuvwxyz0123456789ABCD";

describe("pairing token codec", () => {
  it("round-trips a typical token", () => {
    const token = encodePairingToken(
      { platformUrl: "https://app.appstrate.dev", providerId: "codex" },
      VALID_SECRET,
    );
    const decoded = decodePairingToken(token);
    expect(decoded.platformUrl).toBe("https://app.appstrate.dev");
    expect(decoded.providerId).toBe("codex");
    expect(decoded.raw).toBe(token);
  });

  it("strips trailing slashes from platformUrl on encode", () => {
    const token = encodePairingToken(
      { platformUrl: "https://example.com///", providerId: "codex" },
      VALID_SECRET,
    );
    expect(decodePairingToken(token).platformUrl).toBe("https://example.com");
  });

  it("accepts loopback over plain HTTP", () => {
    expect(() =>
      encodePairingToken(
        { platformUrl: "http://localhost:3000", providerId: "codex" },
        VALID_SECRET,
      ),
    ).not.toThrow();
    expect(() =>
      encodePairingToken(
        { platformUrl: "http://127.0.0.1:3000", providerId: "codex" },
        VALID_SECRET,
      ),
    ).not.toThrow();
  });

  it("rejects plain HTTP for non-loopback hosts", () => {
    expect(() =>
      encodePairingToken({ platformUrl: "http://example.com", providerId: "codex" }, VALID_SECRET),
    ).toThrow(/HTTPS or loopback/);
  });

  it("rejects non-http(s) protocols", () => {
    expect(() =>
      encodePairingToken({ platformUrl: "file:///etc/passwd", providerId: "codex" }, VALID_SECRET),
    ).toThrow();
  });

  it("rejects malformed providerIds on encode", () => {
    expect(() =>
      encodePairingToken({ platformUrl: "https://x.dev", providerId: "Bad/ID" }, VALID_SECRET),
    ).toThrow(/providerId/);
  });

  it("rejects too-short secrets on encode", () => {
    expect(() =>
      encodePairingToken({ platformUrl: "https://x.dev", providerId: "codex" }, "short"),
    ).toThrow(/secret/);
  });

  it("rejects tokens missing the prefix", () => {
    expect(() => decodePairingToken("notapairingtoken")).toThrow(/prefix/);
  });

  it("rejects tokens with malformed body", () => {
    expect(() => decodePairingToken("appp_xxx")).toThrow(/malformed/);
  });

  it("rejects tokens with non-base64 header", () => {
    expect(() => decodePairingToken("appp_!!!.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow();
  });

  it("rejects unsupported header version", () => {
    const headerJson = JSON.stringify({ u: "https://x.dev", p: "codex", v: 99 });
    const headerB64 = Buffer.from(headerJson, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingToken(`appp_${headerB64}.${VALID_SECRET}`)).toThrow(/version/);
  });

  it("rejects HTTP non-loopback URLs at decode time too", () => {
    const headerJson = JSON.stringify({ u: "http://malicious.example", p: "codex", v: 1 });
    const headerB64 = Buffer.from(headerJson, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePairingToken(`appp_${headerB64}.${VALID_SECRET}`)).toThrow(
      /HTTPS or loopback/,
    );
  });
});

describe("hashPairingSecret", () => {
  it("returns a stable base64url SHA-256 hash of the secret portion", async () => {
    const token = encodePairingToken(
      { platformUrl: "https://app.appstrate.dev", providerId: "codex" },
      VALID_SECRET,
    );
    const h1 = await hashPairingSecret(token);
    const h2 = await hashPairingSecret(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h1.length).toBeGreaterThan(40);
  });

  it("ignores the header portion (different header → same hash for same secret)", async () => {
    const t1 = encodePairingToken(
      { platformUrl: "https://app.appstrate.dev", providerId: "codex" },
      VALID_SECRET,
    );
    const t2 = encodePairingToken(
      { platformUrl: "https://other.example.com", providerId: "codex" },
      VALID_SECRET,
    );
    expect(await hashPairingSecret(t1)).toBe(await hashPairingSecret(t2));
  });

  it("produces different hashes for different secrets", async () => {
    const t1 = encodePairingToken(
      { platformUrl: "https://app.appstrate.dev", providerId: "codex" },
      VALID_SECRET,
    );
    const t2 = encodePairingToken(
      { platformUrl: "https://app.appstrate.dev", providerId: "codex" },
      VALID_SECRET.replace("0", "9"),
    );
    expect(await hashPairingSecret(t1)).not.toBe(await hashPairingSecret(t2));
  });
});
