// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildSidecarCredentials } from "../src/credentials.ts";

describe("buildSidecarCredentials", () => {
  describe("basic_api_key_x encoding", () => {
    it("encodes api_key:X in base64 and preserves extra fields", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_api_key_123", subdomain: "mycompany" },
        { credentialEncoding: "basic_api_key_x", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      const decoded = Buffer.from(result.api_key!, "base64").toString();
      expect(decoded).toBe("my_api_key_123:X");
      // Extra fields preserved for URL substitution (e.g. {{subdomain}})
      expect(result.subdomain).toBe("mycompany");
    });

    it("handles special characters in api key", () => {
      const result = buildSidecarCredentials(
        { api_key: "key+with/special=chars" },
        { credentialEncoding: "basic_api_key_x", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      const decoded = Buffer.from(result.api_key!, "base64").toString();
      expect(decoded).toBe("key+with/special=chars:X");
    });

    it("falls through to fieldName mapping when api_key is missing", () => {
      const result = buildSidecarCredentials(
        { subdomain: "mycompany" },
        { credentialEncoding: "basic_api_key_x", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      // No api_key to encode, falls through — fieldName maps but no value found
      expect(result.subdomain).toBe("mycompany");
    });
  });

  describe("basic_email_token encoding", () => {
    it("encodes email/token:api_key in base64 (Zendesk pattern)", () => {
      const result = buildSidecarCredentials(
        { api_key: "zendesk_token_abc", email: "agent@company.com", subdomain: "myco" },
        { credentialEncoding: "basic_email_token", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      const decoded = Buffer.from(result.api_key!, "base64").toString();
      expect(decoded).toBe("agent@company.com/token:zendesk_token_abc");
      // Extra fields preserved
      expect(result.email).toBe("agent@company.com");
      expect(result.subdomain).toBe("myco");
    });

    it("falls through when email is missing", () => {
      const result = buildSidecarCredentials(
        { api_key: "zendesk_token_abc" },
        { credentialEncoding: "basic_email_token", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      // No email → encoding skipped, falls through to fieldName mapping
      expect(result).toEqual({ api_key: "zendesk_token_abc" });
    });
  });

  describe("no encoding (standard fieldName mapping)", () => {
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
      const result = buildSidecarCredentials(
        { api_key: "my_key", extra: "value" },
        {},
        "api_key",
      );
      expect(result).toEqual({ api_key: "my_key", extra: "value" });
    });
  });

  describe("unknown encoding", () => {
    it("falls through to fieldName mapping for unknown encoding values", () => {
      const result = buildSidecarCredentials(
        { api_key: "my_key", subdomain: "myco" },
        { credentialEncoding: "unknown_method", credentials: { fieldName: "api_key" } },
        "api_key",
      );
      // Unknown encoding → ignored, standard fieldName mapping applied
      expect(result).toEqual({ api_key: "my_key" });
    });
  });
});
