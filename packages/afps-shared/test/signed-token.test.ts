// SPDX-License-Identifier: Apache-2.0

/**
 * Keyring-HMAC capability tokens — the codec behind every short-lived,
 * URL-carried capability the platform mints.
 *
 * The property under test is DOMAIN SEPARATION, and it is asserted in BOTH
 * DIRECTIONS. The two production token types that share a signing secret
 * (`UPLOAD_SIGNING_SECRET` backs both filesystem upload URLs and document
 * previews) must be mutually unforgeable: a preview token must not open an
 * upload sink, AND an upload token must not open a preview. A one-directional
 * check is exactly the asymmetry this module was written to remove — a domain
 * mixed into only one side still lets the other type's token through.
 */

import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signKeyringToken, verifyKeyringToken, toKeyring } from "../src/signed-token.ts";

/** The two real production domains that share one signing secret. */
const PREVIEW_DOMAIN = "doc-preview.v1.";
const UPLOAD_DOMAIN = "fs-upload.v1.";
const SHARED_SECRET = "s".repeat(32);

describe("signKeyringToken / verifyKeyringToken — round trip", () => {
  it("verifies a token under the domain it was signed with", () => {
    const payload = { documentId: "doc_abc12345", exp: 1_800_000_000 };
    const token = signKeyringToken(PREVIEW_DOMAIN, payload, SHARED_SECRET);
    expect(verifyKeyringToken<typeof payload>(PREVIEW_DOMAIN, token, SHARED_SECRET)).toEqual(
      payload,
    );
  });

  it("throws when the keyring holds no usable key", () => {
    expect(() => signKeyringToken(PREVIEW_DOMAIN, {}, "")).toThrow(
      "signKeyringToken requires at least one signing key",
    );
    expect(() => signKeyringToken(PREVIEW_DOMAIN, {}, [])).toThrow(
      "signKeyringToken requires at least one signing key",
    );
  });
});

describe("domain separation — asserted in BOTH directions", () => {
  const previewPayload = { documentId: "doc_abc12345", exp: 1_800_000_000 };
  const uploadPayload = { bucket: "documents", path: "org/doc_abc12345", exp: 1_800_000_000 };

  it("a PREVIEW token is refused by the UPLOAD domain (same secret)", () => {
    const token = signKeyringToken(PREVIEW_DOMAIN, previewPayload, SHARED_SECRET);
    // Sanity: it is a valid token — under its own domain.
    expect(verifyKeyringToken<typeof previewPayload>(PREVIEW_DOMAIN, token, SHARED_SECRET)).toEqual(
      previewPayload,
    );
    // …and worthless under the other one, despite the shared signing secret.
    expect(verifyKeyringToken(UPLOAD_DOMAIN, token, SHARED_SECRET)).toBeNull();
  });

  it("an UPLOAD token is refused by the PREVIEW domain (same secret)", () => {
    const token = signKeyringToken(UPLOAD_DOMAIN, uploadPayload, SHARED_SECRET);
    expect(verifyKeyringToken<typeof uploadPayload>(UPLOAD_DOMAIN, token, SHARED_SECRET)).toEqual(
      uploadPayload,
    );
    expect(verifyKeyringToken(PREVIEW_DOMAIN, token, SHARED_SECRET)).toBeNull();
  });

  it("the separation holds for an arbitrary domain pair, both ways", () => {
    const a = signKeyringToken("alpha.v1.", { n: 1 }, SHARED_SECRET);
    const b = signKeyringToken("beta.v1.", { n: 1 }, SHARED_SECRET);
    // Identical payload + identical secret — only the domain differs, so the
    // two signatures must differ and neither must verify as the other.
    expect(a).not.toBe(b);
    expect(verifyKeyringToken("beta.v1.", a, SHARED_SECRET)).toBeNull();
    expect(verifyKeyringToken("alpha.v1.", b, SHARED_SECRET)).toBeNull();
  });

  it("a domain that is a PREFIX of another does not verify across the two", () => {
    // `update(domain + body)` concatenates without a separator, so a domain
    // that prefixes another could otherwise collide with a shifted body.
    const token = signKeyringToken("doc.", { n: 1 }, SHARED_SECRET);
    expect(verifyKeyringToken("doc.v1.", token, SHARED_SECRET)).toBeNull();
    const longer = signKeyringToken("doc.v1.", { n: 1 }, SHARED_SECRET);
    expect(verifyKeyringToken("doc.", longer, SHARED_SECRET)).toBeNull();
  });
});

describe("signature integrity", () => {
  it("rejects a tampered payload under the correct domain", () => {
    const token = signKeyringToken(PREVIEW_DOMAIN, { documentId: "doc_mine" }, SHARED_SECRET);
    const forgedBody = Buffer.from(JSON.stringify({ documentId: "doc_yours" }), "utf-8").toString(
      "base64url",
    );
    const tampered = `${forgedBody}.${token.slice(token.indexOf(".") + 1)}`;
    expect(verifyKeyringToken(PREVIEW_DOMAIN, tampered, SHARED_SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signKeyringToken(PREVIEW_DOMAIN, { n: 1 }, SHARED_SECRET);
    expect(verifyKeyringToken(PREVIEW_DOMAIN, token, "x".repeat(32))).toBeNull();
  });

  it("rejects malformed shapes without throwing", () => {
    for (const bad of ["", ".", "nodot", ".onlysig", "a.b.c"]) {
      expect(verifyKeyringToken(PREVIEW_DOMAIN, bad, SHARED_SECRET)).toBeNull();
    }
  });

  it("rejects a correctly-signed body that is not JSON", () => {
    // Signature valid, payload undecodable — must return null, never throw.
    const body = Buffer.from("not-json", "utf-8").toString("base64url");
    const sig = createHmac("sha256", SHARED_SECRET)
      .update(PREVIEW_DOMAIN + body)
      .digest("base64url");
    expect(verifyKeyringToken(PREVIEW_DOMAIN, `${body}.${sig}`, SHARED_SECRET)).toBeNull();
  });
});

describe("keyring rotation", () => {
  const OLD = "old-key-".padEnd(32, "o");
  const NEW = "new-key-".padEnd(32, "n");

  it("signs with the FIRST key and verifies against every key", () => {
    // Token minted before the rotation (old key was active/first).
    const beforeRotation = signKeyringToken(PREVIEW_DOMAIN, { n: 1 }, OLD);
    // After rotation the new key is prepended; the in-flight token still works.
    const rotated = `${NEW},${OLD}`;
    expect(verifyKeyringToken<{ n: number }>(PREVIEW_DOMAIN, beforeRotation, rotated)).toEqual({
      n: 1,
    });

    // And a token minted after the rotation is signed by the NEW key —
    // provably, because it fails to verify against the old key alone.
    const afterRotation = signKeyringToken(PREVIEW_DOMAIN, { n: 2 }, rotated);
    expect(verifyKeyringToken<{ n: number }>(PREVIEW_DOMAIN, afterRotation, NEW)).toEqual({ n: 2 });
    expect(verifyKeyringToken(PREVIEW_DOMAIN, afterRotation, OLD)).toBeNull();
  });

  it("stops accepting a token once its key leaves the keyring", () => {
    const token = signKeyringToken(PREVIEW_DOMAIN, { n: 1 }, OLD);
    expect(verifyKeyringToken(PREVIEW_DOMAIN, token, NEW)).toBeNull();
  });

  it("rotation does not weaken domain separation", () => {
    const rotated = `${NEW},${OLD}`;
    const token = signKeyringToken(UPLOAD_DOMAIN, { n: 1 }, rotated);
    expect(verifyKeyringToken(PREVIEW_DOMAIN, token, rotated)).toBeNull();
  });

  it("toKeyring splits on commas and drops empty segments", () => {
    expect(toKeyring(`${NEW},${OLD}`)).toEqual([NEW, OLD]);
    expect(toKeyring(`,${NEW},,${OLD},`)).toEqual([NEW, OLD]);
    expect(toKeyring("")).toEqual([]);
    expect(toKeyring([NEW, OLD])).toEqual([NEW, OLD]);
  });
});
