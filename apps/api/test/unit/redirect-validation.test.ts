// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { ApiError } from "../../src/lib/errors.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import { validateReturnUrl, validateDomainList } from "../../src/services/redirect-validation.ts";

// --- Env control via process.env + cache reset (no mock.module) ---

const originalAppUrl = process.env.APP_URL;

function setProdEnv() {
  process.env.APP_URL = "https://app.appstrate.dev";
  _resetCacheForTesting();
}

function setDevEnv() {
  process.env.APP_URL = "http://localhost:3000";
  _resetCacheForTesting();
}

afterAll(() => {
  process.env.APP_URL = originalAppUrl;
  _resetCacheForTesting();
});

function expectThrows(fn: () => void): ApiError {
  try {
    fn();
    throw new Error("Expected ApiError but no error was thrown");
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
}

describe("validateReturnUrl", () => {
  beforeEach(() => setProdEnv());

  describe("scheme validation", () => {
    it("accepts https URLs when domain is allowed", () => {
      validateReturnUrl("https://myapp.com/callback", ["myapp.com"]);
    });

    it("rejects http in production", () => {
      const err = expectThrows(() => validateReturnUrl("http://myapp.com/callback", ["myapp.com"]));
      expect(err.code).toBe("invalid_request");
      expect(err.param).toBe("returnUrl");
    });

    it("allows http://localhost in dev", () => {
      setDevEnv();
      validateReturnUrl("http://localhost:3001/callback", []);
    });

    it("allows http://127.0.0.1 in dev", () => {
      setDevEnv();
      validateReturnUrl("http://127.0.0.1:8080/callback", []);
    });

    it("rejects http://localhost in production", () => {
      expectThrows(() => validateReturnUrl("http://localhost:3000/callback", []));
    });
  });

  describe("dangerous schemes", () => {
    it("blocks javascript:", () => {
      expectThrows(() => validateReturnUrl("javascript:alert(1)", ["example.com"]));
    });

    it("blocks data:", () => {
      expectThrows(() => validateReturnUrl("data:text/html,<script>", ["example.com"]));
    });

    it("blocks vbscript:", () => {
      expectThrows(() => validateReturnUrl("vbscript:msgbox", ["example.com"]));
    });

    it("blocks file:", () => {
      expectThrows(() => validateReturnUrl("file:///etc/passwd", ["example.com"]));
    });
  });

  describe("protocol-relative URLs", () => {
    it("blocks //evil.com", () => {
      expectThrows(() => validateReturnUrl("//evil.com/callback", ["evil.com"]));
    });
  });

  describe("malformed URLs", () => {
    it("rejects garbage input", () => {
      expectThrows(() => validateReturnUrl("not-a-url", ["example.com"]));
    });
  });

  describe("domain allowlist", () => {
    it("accepts exact domain match", () => {
      validateReturnUrl("https://myapp.com/done", ["myapp.com"]);
    });

    it("accepts subdomain match", () => {
      validateReturnUrl("https://staging.myapp.com/done", ["myapp.com"]);
    });

    it("accepts deeply nested subdomain", () => {
      validateReturnUrl("https://a.b.myapp.com/done", ["myapp.com"]);
    });

    it("rejects non-matching domain", () => {
      const err = expectThrows(() => validateReturnUrl("https://evil.com/done", ["myapp.com"]));
      expect(err.message).toContain("evil.com");
    });

    it("rejects partial suffix match (notmyapp.com)", () => {
      expectThrows(() => validateReturnUrl("https://notmyapp.com/done", ["myapp.com"]));
    });

    it("rejects when allowlist is empty", () => {
      expectThrows(() => validateReturnUrl("https://myapp.com/done", []));
    });

    it("case insensitive matching", () => {
      validateReturnUrl("https://MyApp.COM/done", ["myapp.com"]);
    });

    it("matches any domain in the list", () => {
      validateReturnUrl("https://staging.dev-app.com/done", ["myapp.com", "dev-app.com"]);
    });
  });
});

describe("validateDomainList", () => {
  it("accepts valid domain list", () => {
    expect(validateDomainList(["example.com", "myapp.dev"])).toBeNull();
  });

  it("accepts empty list", () => {
    expect(validateDomainList([])).toBeNull();
  });

  it("rejects more than 20 domains", () => {
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);
    expect(validateDomainList(domains)).toContain("Maximum 20");
  });

  it("rejects invalid domain format", () => {
    expect(validateDomainList(["https://example.com"])).toContain("Invalid domain");
  });

  it("rejects domain with spaces", () => {
    expect(validateDomainList(["my app.com"])).toContain("Invalid domain");
  });

  it("accepts hyphenated domains", () => {
    expect(validateDomainList(["my-app.com"])).toBeNull();
  });

  it("accepts subdomains", () => {
    expect(validateDomainList(["staging.my-app.com"])).toBeNull();
  });

  it("rejects domain starting with hyphen", () => {
    expect(validateDomainList(["-invalid.com"])).toContain("Invalid domain");
  });
});
