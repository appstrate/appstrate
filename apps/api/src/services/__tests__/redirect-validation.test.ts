import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ApiError } from "../../lib/errors.ts";

// --- Mock getEnv to control APP_URL ---

let mockAppUrl = "https://app.appstrate.dev";

mock.module("@appstrate/env", () => ({
  getEnv: () => ({ APP_URL: mockAppUrl }),
}));

const { validateReturnUrl, validateDomainList } = await import("../redirect-validation.ts");

function setProdEnv() {
  mockAppUrl = "https://app.appstrate.dev";
}

function setDevEnv() {
  mockAppUrl = "http://localhost:3000";
}

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
    test("accepts https URLs when domain is whitelisted", () => {
      validateReturnUrl("https://myapp.com/callback", ["myapp.com"]);
    });

    test("rejects http in production", () => {
      const err = expectThrows(() => validateReturnUrl("http://myapp.com/callback", ["myapp.com"]));
      expect(err.code).toBe("invalid_request");
      expect(err.param).toBe("returnUrl");
    });

    test("allows http://localhost in dev", () => {
      setDevEnv();
      validateReturnUrl("http://localhost:3001/callback", []);
    });

    test("allows http://127.0.0.1 in dev", () => {
      setDevEnv();
      validateReturnUrl("http://127.0.0.1:8080/callback", []);
    });

    test("rejects http://localhost in production", () => {
      expectThrows(() => validateReturnUrl("http://localhost:3000/callback", []));
    });
  });

  describe("dangerous schemes", () => {
    test("blocks javascript:", () => {
      expectThrows(() => validateReturnUrl("javascript:alert(1)", ["example.com"]));
    });

    test("blocks data:", () => {
      expectThrows(() => validateReturnUrl("data:text/html,<script>", ["example.com"]));
    });

    test("blocks vbscript:", () => {
      expectThrows(() => validateReturnUrl("vbscript:msgbox", ["example.com"]));
    });

    test("blocks file:", () => {
      expectThrows(() => validateReturnUrl("file:///etc/passwd", ["example.com"]));
    });
  });

  describe("protocol-relative URLs", () => {
    test("blocks //evil.com", () => {
      expectThrows(() => validateReturnUrl("//evil.com/callback", ["evil.com"]));
    });
  });

  describe("malformed URLs", () => {
    test("rejects garbage input", () => {
      expectThrows(() => validateReturnUrl("not-a-url", ["example.com"]));
    });
  });

  describe("domain whitelist", () => {
    test("accepts exact domain match", () => {
      validateReturnUrl("https://myapp.com/done", ["myapp.com"]);
    });

    test("accepts subdomain match", () => {
      validateReturnUrl("https://staging.myapp.com/done", ["myapp.com"]);
    });

    test("accepts deeply nested subdomain", () => {
      validateReturnUrl("https://a.b.myapp.com/done", ["myapp.com"]);
    });

    test("rejects non-matching domain", () => {
      const err = expectThrows(() => validateReturnUrl("https://evil.com/done", ["myapp.com"]));
      expect(err.message).toContain("evil.com");
    });

    test("rejects partial suffix match (notmyapp.com)", () => {
      expectThrows(() => validateReturnUrl("https://notmyapp.com/done", ["myapp.com"]));
    });

    test("rejects when whitelist is empty", () => {
      expectThrows(() => validateReturnUrl("https://myapp.com/done", []));
    });

    test("case insensitive matching", () => {
      validateReturnUrl("https://MyApp.COM/done", ["myapp.com"]);
    });

    test("matches any domain in the list", () => {
      validateReturnUrl("https://staging.dev-app.com/done", ["myapp.com", "dev-app.com"]);
    });
  });
});

describe("validateDomainList", () => {
  test("accepts valid domain list", () => {
    expect(validateDomainList(["example.com", "myapp.dev"])).toBeNull();
  });

  test("accepts empty list", () => {
    expect(validateDomainList([])).toBeNull();
  });

  test("rejects more than 20 domains", () => {
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);
    expect(validateDomainList(domains)).toContain("Maximum 20");
  });

  test("rejects invalid domain format", () => {
    expect(validateDomainList(["https://example.com"])).toContain("Invalid domain");
  });

  test("rejects domain with spaces", () => {
    expect(validateDomainList(["my app.com"])).toContain("Invalid domain");
  });

  test("accepts hyphenated domains", () => {
    expect(validateDomainList(["my-app.com"])).toBeNull();
  });

  test("accepts subdomains", () => {
    expect(validateDomainList(["staging.my-app.com"])).toBeNull();
  });

  test("rejects domain starting with hyphen", () => {
    expect(validateDomainList(["-invalid.com"])).toContain("Invalid domain");
  });
});
