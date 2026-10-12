// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `maskCredentialLabel` — the structural picker that turns a
 * single-secret credential bag into a masked fingerprint label, and refuses
 * to label ambiguous multi-secret or never-show (password) fields.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintSecret, maskCredentialLabel } from "../../src/services/connect/mask-label.ts";

const SOURCES_DIR = join(import.meta.dir, "../../../../scripts/system-packages");

/** The `primary` credentials schema of a system integration, located by name. */
function systemSchema(name: string): Record<string, unknown> {
  const [dir] = readdirSync(SOURCES_DIR).filter((d) =>
    new RegExp(`^integration-${name}-\\d+\\.\\d+\\.\\d+$`).test(d),
  );
  const manifest = JSON.parse(readFileSync(join(SOURCES_DIR, dir!, "manifest.json"), "utf8"));
  return manifest.auths.primary.credentials.schema;
}

describe("maskCredentialLabel — system integrations", () => {
  const label = (name: string, credentials: Record<string, string>) =>
    maskCredentialLabel(systemSchema(name), credentials);

  it("names a connection after its one identifying field", () => {
    expect(label("twilio", { account_sid: "AC0123456789abcd", auth_token: "t".repeat(32) })).toBe(
      "AC****abcd",
    );
  });

  it("never names one after an address every account shares the shape of", () => {
    expect(
      label("activecampaign", {
        api_url: "https://acme.api-us1.com",
        api_key: "ackey-0123456789",
      }),
    ).toBe("ac****6789");
    expect(
      label("shopify", { shop_domain: "acme.myshopify.com", access_token: "shpat_0123456789" }),
    ).toBe("sh****6789");
    expect(
      label("woocommerce", {
        site_url: "https://shop.acme.test",
        consumer_key: "ck_0123456789",
        consumer_secret: "cs_0123456789",
      }),
    ).toBeUndefined();
  });

  it("fingerprints the key of a key-only integration, a webhook URL included", () => {
    expect(label("firecrawl", { api_key: "fc-xxxxxxxxf10b" })).toBe("fc****f10b");
    expect(label("webhooks", { webhook_url: "https://hooks.acme.test/T0/B1/x9Zq" })).toBe(
      "ht****x9Zq",
    );
  });
});

describe("fingerprintSecret", () => {
  it("masks the middle, keeping 2-char prefix + last 4", () => {
    expect(fingerprintSecret("fc-abcdef01f10b")).toBe("fc****f10b");
  });

  it("returns undefined for values shorter than 8 chars", () => {
    expect(fingerprintSecret("short")).toBeUndefined();
    expect(fingerprintSecret("1234567")).toBeUndefined();
    expect(fingerprintSecret("12345678")).toBe("12****5678");
  });

  it("returns undefined for non-strings", () => {
    expect(fingerprintSecret(undefined)).toBeUndefined();
    expect(fingerprintSecret(42)).toBeUndefined();
    expect(fingerprintSecret(null)).toBeUndefined();
  });
});

describe("maskCredentialLabel", () => {
  it("masks the sole string secret of a single-field schema", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    };
    expect(maskCredentialLabel(schema, { api_key: "sk_live_abcdef12a1b2" })).toBe("sk****a1b2");
  });

  it("ignores an optional non-required field when a single required secret exists", () => {
    const schema = {
      type: "object",
      properties: {
        api_key: { type: "string" },
        base_url: { type: "string" },
      },
      required: ["api_key"],
    };
    expect(
      maskCredentialLabel(schema, { api_key: "key_abcdef12cdef", base_url: "https://x" }),
    ).toBe("ke****cdef");
  });

  it("returns undefined for ambiguous multi-secret schemas (Twilio)", () => {
    const schema = {
      type: "object",
      properties: {
        account_sid: { type: "string" },
        auth_token: { type: "string" },
      },
      required: ["account_sid", "auth_token"],
    };
    expect(
      maskCredentialLabel(schema, { account_sid: "ACxxxxxxxxxxxx", auth_token: "toktoktoktok" }),
    ).toBeUndefined();
  });

  it("excludes format:password fields (never-show class)", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string" },
        password: { type: "string", format: "password" },
      },
      required: ["email", "password"],
    };
    // password dropped → only `email` remains → single candidate masked.
    expect(
      maskCredentialLabel(schema, { email: "user@example.com", password: "hunter2hunter" }),
    ).toBe("us****.com");
  });

  it("fingerprints the one secret of a key-only auth", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string", writeOnly: true }, base_url: { type: "string" } },
      required: ["api_key"],
    };
    expect(maskCredentialLabel(schema, { api_key: "fc-xxxxxxxxf10b" })).toBe("fc****f10b");
  });

  it("never fingerprints a password, nor one secret among several", () => {
    const password = { type: "string", format: "password" };
    const secret = { type: "string", writeOnly: true };
    expect(
      maskCredentialLabel(
        { type: "object", properties: { password }, required: ["password"] },
        { password: "supersecretvalue" },
      ),
    ).toBeUndefined();
    expect(
      maskCredentialLabel(
        { type: "object", properties: { key: secret, token: secret }, required: ["key", "token"] },
        { key: "aaaaaaaaaaaa", token: "bbbbbbbbbbbb" },
      ),
    ).toBeUndefined();
  });

  it("prefers the one non-secret field over a secret beside it", () => {
    const schema = {
      type: "object",
      properties: {
        account_sid: { type: "string" },
        auth_token: { type: "string", writeOnly: true },
      },
      required: ["account_sid", "auth_token"],
    };
    expect(
      maskCredentialLabel(schema, { account_sid: "AC0123456789", auth_token: "toktoktoktok" }),
    ).toBe("AC****6789");
  });

  it('handles union string types ["string","null"]', () => {
    const schema = {
      type: "object",
      properties: { token: { type: ["string", "null"] } },
      required: ["token"],
    };
    expect(maskCredentialLabel(schema, { token: "tok_abcdef12wxyz" })).toBe("to****wxyz");
  });

  it("returns undefined when the secret value is too short to fingerprint", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
      required: ["api_key"],
    };
    expect(maskCredentialLabel(schema, { api_key: "abc" })).toBeUndefined();
  });

  it("returns undefined for a missing/empty schema", () => {
    expect(maskCredentialLabel(undefined, { api_key: "whatever_long_value" })).toBeUndefined();
    expect(
      maskCredentialLabel({ type: "object" }, { api_key: "whatever_long_value" }),
    ).toBeUndefined();
  });

  it("falls back to all string fields when no required array is present", () => {
    const schema = {
      type: "object",
      properties: { api_key: { type: "string" } },
    };
    expect(maskCredentialLabel(schema, { api_key: "key_abcdef12ghij" })).toBe("ke****ghij");
  });
});
