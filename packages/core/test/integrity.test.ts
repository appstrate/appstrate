// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { computeIntegrity } from "../src/integrity.ts";

describe("computeIntegrity", () => {
  it("returns sha256-base64 format", () => {
    const data = new TextEncoder().encode("hello world");
    const result = computeIntegrity(data);
    expect(result).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  it("deterministic — same input yields same hash", () => {
    const data = new TextEncoder().encode("test data for hashing");
    const a = computeIntegrity(data);
    const b = computeIntegrity(data);
    expect(a).toBe(b);
  });

  it("different inputs yield different hashes", () => {
    const a = computeIntegrity(new TextEncoder().encode("input-a"));
    const b = computeIntegrity(new TextEncoder().encode("input-b"));
    expect(a).not.toBe(b);
  });
});
