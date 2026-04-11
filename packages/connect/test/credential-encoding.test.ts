// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildSidecarCredentials } from "../src/credentials.ts";

describe("buildSidecarCredentials", () => {
  describe("credentialTransform (new template-based API)", () => {
    it("encodes {{api_key}}:X in base64 and preserves extra fields (Freshdesk/Teamwork)", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_api_key_123", subdomain: "mycompany" },
        {
          credentialTransform: { template: "{{api_key}}:X", encoding: "base64" },
          credentials: { fieldName: "api_key" },
        },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("my_api_key_123:X");
      // Extra fields preserved for URL substitution via {{subdomain}}
      expect(result.subdomain).toBe("mycompany");
    });

    it("encodes {{email}}/token:{{api_key}} in base64 (Zendesk)", () => {
      const result = buildSidecarCredentials(
        { api_key: "zendesk_token_abc", email: "agent@company.com", subdomain: "myco" },
        {
          credentialTransform: {
            template: "{{email}}/token:{{api_key}}",
            encoding: "base64",
          },
          credentials: { fieldName: "api_key" },
        },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe(
        "agent@company.com/token:zendesk_token_abc",
      );
      expect(result.email).toBe("agent@company.com");
      expect(result.subdomain).toBe("myco");
    });

    it("handles special characters in the rendered template", () => {
      const result = buildSidecarCredentials(
        { api_key: "key+with/special=chars" },
        {
          credentialTransform: { template: "{{api_key}}:X", encoding: "base64" },
          credentials: { fieldName: "api_key" },
        },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("key+with/special=chars:X");
    });

    it("falls through to fieldName mapping when a referenced field is missing", () => {
      // Zendesk template needs both email and api_key — email is missing.
      const result = buildSidecarCredentials(
        { api_key: "zendesk_token_abc" },
        {
          credentialTransform: {
            template: "{{email}}/token:{{api_key}}",
            encoding: "base64",
          },
          credentials: { fieldName: "api_key" },
        },
        "api_key",
      );
      expect(result).toEqual({ api_key: "zendesk_token_abc" });
    });

    it("uses credentials.fieldName to place the encoded value", () => {
      const result = buildSidecarCredentials(
        { api_key: "k", subdomain: "s" },
        {
          credentialTransform: { template: "{{api_key}}:X", encoding: "base64" },
          credentials: { fieldName: "token" },
        },
        "api_key",
      );
      expect(Buffer.from(result.token!, "base64").toString()).toBe("k:X");
      // fieldName defaults used; api_key still present because we return the full credential map.
      expect(result.api_key).toBe("k");
      expect(result.subdomain).toBe("s");
    });

    it("defaults fieldName to 'api_key' when credentials.fieldName is absent", () => {
      const result = buildSidecarCredentials(
        { api_key: "k" },
        { credentialTransform: { template: "{{api_key}}:X", encoding: "base64" } },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("k:X");
    });

    it("throws on unknown encoding (exhaustiveness guard)", () => {
      expect(() =>
        buildSidecarCredentials(
          { api_key: "k" },
          {
            credentialTransform: { template: "{{api_key}}", encoding: "rot13" },
            credentials: { fieldName: "api_key" },
          },
          "api_key",
        ),
      ).toThrow(/Unsupported credentialTransform encoding/);
    });

    it("is ignored for non-api_key auth modes", () => {
      const result = buildSidecarCredentials(
        { access_token: "tok" },
        {
          credentialTransform: { template: "{{access_token}}", encoding: "base64" },
          credentials: { fieldName: "access_token" },
        },
        "oauth2",
      );
      // Transform skipped — standard oauth2 fieldName mapping applies.
      expect(result).toEqual({ access_token: "tok" });
    });
  });

  describe("credentialEncoding (legacy, deprecated)", () => {
    it("basic_api_key_x still works via the legacy compatibility path", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_api_key_123", subdomain: "mycompany" },
        { credentialEncoding: "basic_api_key_x", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("my_api_key_123:X");
      expect(result.subdomain).toBe("mycompany");
    });

    it("basic_email_token still works via the legacy compatibility path", () => {
      const result = buildSidecarCredentials(
        { api_key: "zendesk_token", email: "a@b.com" },
        { credentialEncoding: "basic_email_token", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("a@b.com/token:zendesk_token");
    });

    it("credentialTransform wins when both are present", () => {
      const result = buildSidecarCredentials(
        { api_key: "k" },
        {
          credentialTransform: { template: "transform_wins:{{api_key}}", encoding: "base64" },
          credentialEncoding: "basic_api_key_x",
          credentials: { fieldName: "api_key" },
        },
        "api_key",
      );
      expect(Buffer.from(result.api_key!, "base64").toString()).toBe("transform_wins:k");
    });

    it("falls through to fieldName mapping for unknown legacy encoding values", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_key", subdomain: "myco" },
        { credentialEncoding: "unknown_method", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      expect(result).toEqual({ api_key: "my_key" });
    });
  });

  describe("no transform (standard fieldName mapping)", () => {
    it("maps to fieldName for oauth2", () => {
      const result = buildSidecarCredentials(
        { access_token: "tok_123", refresh_token: "ref_456" },
        { credentials: { fieldName: "access_token" } },
        "oauth2",
      );
      expect(result).toEqual({ access_token: "tok_123" });
    });

    it("maps to fieldName for api_key without encoding", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_key" },
        { credentials: { fieldName: "api_key" } },
        "api_key",
      );
      expect(result).toEqual({ api_key: "my_key" });
    });

    it("returns all credentials when no fieldName", () => {
      const result = buildSidecarCredentials({ api_key: "my_key", extra: "value" }, {}, "api_key");
      expect(result).toEqual({ api_key: "my_key", extra: "value" });
    });
  });
});
