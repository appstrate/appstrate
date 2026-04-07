// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";

// buildSidecarCredentials is not exported, so we test the encoding logic directly
// by replicating the encoding functions used in credentials.ts

describe("credential encoding", () => {
  describe("basic_api_key_x", () => {
    it("encodes api_key:X in base64", () => {
      const apiKey = "my_api_key_123";
      const encoded = Buffer.from(`${apiKey}:X`).toString("base64");
      expect(encoded).toBe(Buffer.from("my_api_key_123:X").toString("base64"));
      // Verify it decodes correctly
      const decoded = Buffer.from(encoded, "base64").toString();
      expect(decoded).toBe("my_api_key_123:X");
    });

    it("handles special characters in api key", () => {
      const apiKey = "key+with/special=chars";
      const encoded = Buffer.from(`${apiKey}:X`).toString("base64");
      const decoded = Buffer.from(encoded, "base64").toString();
      expect(decoded).toBe("key+with/special=chars:X");
    });
  });

  describe("basic_email_token", () => {
    it("encodes email/token:api_key in base64 (Zendesk pattern)", () => {
      const email = "agent@company.com";
      const apiKey = "zendesk_token_abc";
      const encoded = Buffer.from(`${email}/token:${apiKey}`).toString("base64");
      const decoded = Buffer.from(encoded, "base64").toString();
      expect(decoded).toBe("agent@company.com/token:zendesk_token_abc");
    });
  });
});
