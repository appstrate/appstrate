import { describe, test, expect } from "bun:test";
import { isOwnedByOrg } from "@appstrate/core/naming";

/**
 * Tests for scope validation on package creation.
 *
 * Scope enforcement is done at the route level via checkScopeMatch() in:
 * - POST /api/flows (flow creation from JSON body)
 * - POST /api/packages/import (ZIP import)
 * - POST /api/providers (provider creation)
 *
 * Skills/tools are safe because the route constructs the packageId
 * from orgSlug before calling createOrgItem().
 */

describe("isOwnedByOrg — scope matching", () => {
  // ── Matching scope ──

  test("scope matching org slug → allowed", () => {
    expect(isOwnedByOrg("@acme/my-flow", "acme")).toBe(true);
  });

  test("scope with hyphens → allowed", () => {
    expect(isOwnedByOrg("@my-org/my-flow", "my-org")).toBe(true);
  });

  test("scope with numbers → allowed", () => {
    expect(isOwnedByOrg("@org123/tool-1", "org123")).toBe(true);
  });

  // ── Mismatching scope ──

  test("different scope → rejected", () => {
    expect(isOwnedByOrg("@other/my-flow", "acme")).toBe(false);
  });

  test("scope is substring of org slug → rejected", () => {
    expect(isOwnedByOrg("@acm/my-flow", "acme")).toBe(false);
  });

  test("scope is superset of org slug → rejected", () => {
    expect(isOwnedByOrg("@acme-corp/my-flow", "acme")).toBe(false);
  });

  // ── Edge cases ──

  test("unscoped package id → rejected", () => {
    expect(isOwnedByOrg("my-flow", "acme")).toBe(false);
  });

  test("empty org slug → rejected", () => {
    expect(isOwnedByOrg("@acme/my-flow", "")).toBe(false);
  });

  test("malformed package id → rejected", () => {
    expect(isOwnedByOrg("@/my-flow", "acme")).toBe(false);
  });

  // ── Applies uniformly to all package types ──

  test("flow with wrong scope → rejected", () => {
    expect(isOwnedByOrg("@evil/data-sync", "acme")).toBe(false);
  });

  test("skill with wrong scope → rejected", () => {
    expect(isOwnedByOrg("@evil/web-scraper", "acme")).toBe(false);
  });

  test("tool with wrong scope → rejected", () => {
    expect(isOwnedByOrg("@evil/calculator", "acme")).toBe(false);
  });

  test("provider with wrong scope → rejected", () => {
    expect(isOwnedByOrg("@evil/gmail", "acme")).toBe(false);
  });
});
