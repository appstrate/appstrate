import { describe, expect, test } from "bun:test";
import { computeIntegrity } from "../src/integrity.ts";

describe("computeIntegrity", () => {
  test("returns sha256-base64 format", () => {
    const data = new TextEncoder().encode("hello world");
    const result = computeIntegrity(data);
    expect(result).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });

  test("deterministic — same input yields same hash", () => {
    const data = new TextEncoder().encode("test data for hashing");
    const a = computeIntegrity(data);
    const b = computeIntegrity(data);
    expect(a).toBe(b);
  });

  test("different inputs yield different hashes", () => {
    const a = computeIntegrity(new TextEncoder().encode("input-a"));
    const b = computeIntegrity(new TextEncoder().encode("input-b"));
    expect(a).not.toBe(b);
  });
});
