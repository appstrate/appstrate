// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { validateDomainList } from "../../src/services/redirect-validation.ts";

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
