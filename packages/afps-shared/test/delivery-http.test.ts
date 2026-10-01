// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  assertHttpFieldValue,
  injectsHttpCredential,
  InvalidHeaderValueError,
  isBareAuthSchemePrefix,
  isHttpFieldValue,
  projectHttpDeliveryConfig,
} from "../src/delivery-http.ts";

describe("projectHttpDeliveryConfig", () => {
  it("returns undefined for an absent block", () => {
    expect(projectHttpDeliveryConfig(undefined)).toBeUndefined();
  });

  it("carries the value template verbatim", () => {
    const cfg = projectHttpDeliveryConfig({
      name: "Authorization",
      prefix: "Bearer ",
      value: "{$credential.token_type} {$credential.access_token}",
    });
    expect(cfg).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      valueFrom: { template: "{$credential.token_type} {$credential.access_token}" },
    });
  });

  it("carries base64 encoding with the template", () => {
    const cfg = projectHttpDeliveryConfig({
      name: "Authorization",
      value: "{$credential.user}:{$credential.pass}",
      encoding: "base64",
    });
    expect(cfg).toEqual({
      valueFrom: { template: "{$credential.user}:{$credential.pass}", encoding: "base64" },
      headerName: "Authorization",
    });
  });

  it("carries allow_server_override → allowServerOverride", () => {
    const cfg = projectHttpDeliveryConfig({ name: "X", allow_server_override: true });
    expect(cfg).toEqual({ headerName: "X", allowServerOverride: true });
  });
});

// The one grammar behind both bare-prefix gates — the integration manifest
// validator (install time) and the portable runtime's local creds file (load
// time). Each gate pins its own message; this pins what they agree on.
describe("isBareAuthSchemePrefix", () => {
  it("is true for a prefix that is nothing but a scheme, in credentials position", () => {
    for (const header of ["Authorization", "authorization", "Proxy-Authorization"]) {
      expect(isBareAuthSchemePrefix(header, "Bearer")).toBe(true);
    }
    expect(isBareAuthSchemePrefix("Authorization", "Zoho-oauthtoken")).toBe(true);
  });

  it("is false for a prefix carrying its own separator, and for no prefix at all", () => {
    for (const prefix of ["Bearer ", "Basic ", "Token token=", ""]) {
      expect(isBareAuthSchemePrefix("Authorization", prefix)).toBe(false);
    }
  });

  it("is false outside credentials position — there a bare token is an ordinary literal", () => {
    expect(isBareAuthSchemePrefix("Cookie", "session")).toBe(false);
    expect(isBareAuthSchemePrefix("X-Api-Key", "Token")).toBe(false);
  });
});

describe("injectsHttpCredential", () => {
  it("follows the auth type's default header when no delivery.http names one", () => {
    for (const type of ["oauth2", "api_key", "basic"]) {
      expect(injectsHttpCredential(type, undefined)).toBe(true);
      expect(injectsHttpCredential(type, { prefix: "Token " })).toBe(true);
    }
    expect(injectsHttpCredential("custom", undefined)).toBe(false);
    expect(injectsHttpCredential("mtls", undefined)).toBe(false);
  });

  it("follows an explicit delivery.http name, an empty one included", () => {
    expect(injectsHttpCredential("custom", { name: "X-Token" })).toBe(true);
    expect(injectsHttpCredential("api_key", { name: "" })).toBe(false);
  });
});

describe("isHttpFieldValue", () => {
  it("accepts HTAB, SP, VCHAR and obs-text", () => {
    for (const v of ["", "Bearer abc.DEF-123", "a\tb c", "caf\u00e9", "\u00ff"]) {
      expect(isHttpFieldValue(v)).toBe(true);
    }
  });

  it("refuses CR, LF, NUL, every other control, DEL and anything above U+00FF", () => {
    for (const v of [
      "k\r\nX: y",
      "k\n",
      "k\u0000",
      "k\u0001",
      "k\u001f",
      "k\u007f",
      "k\u20ac",
      "k\u{1F600}",
    ]) {
      expect(isHttpFieldValue(v)).toBe(false);
    }
  });

  // Every value the runtime's `Headers` refuses, it refuses too: none reaches the TypeError.
  it("is at least as strict as Bun's Headers", () => {
    for (let c = 0; c <= 0x100; c++) {
      const value = `a${String.fromCharCode(c)}b`;
      let headersAccept = true;
      try {
        new Headers().set("x", value);
      } catch {
        headersAccept = false;
      }
      if (!headersAccept) expect(isHttpFieldValue(value)).toBe(false);
    }
  });
});

describe("assertHttpFieldValue", () => {
  it("throws an error naming the header, never the value", () => {
    const secret = "SECRETVALUE\r\nX-Evil: 1";
    let caught: unknown;
    try {
      assertHttpFieldValue("X-Api-Key", secret);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidHeaderValueError);
    expect((caught as InvalidHeaderValueError).header).toBe("X-Api-Key");
    expect((caught as Error).message).toContain("X-Api-Key");
    expect((caught as Error).message).not.toContain("SECRETVALUE");
  });

  it("returns for a valid value", () => {
    expect(() => assertHttpFieldValue("Authorization", "Bearer tok")).not.toThrow();
  });
});
