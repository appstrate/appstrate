// SPDX-License-Identifier: Apache-2.0

/**
 * The directory name `appstrate code sync` falls back to when a skill's served
 * name is taken. Pure, so a re-run names every skill identically.
 */

import { describe, it, expect } from "bun:test";
import { collisionSlug } from "../src/lib/skills-sync/materialize.ts";

describe("collisionSlug", () => {
  it("renders the package id as <scope>-<name>", () => {
    expect(collisionSlug("@acme/pdf-tools", new Set())).toBe("acme-pdf-tools");
  });

  it("appends a counter when the <scope>-<name> form is itself taken", () => {
    const taken = new Set(["acme-foo", "acme-foo-2"]);
    expect(collisionSlug("@acme/foo", taken)).toBe("acme-foo-3");
  });

  it("keeps the counter inside the 64-character ceiling by trimming the base", () => {
    const long = `@${"a".repeat(40)}/${"b".repeat(40)}`;
    const first = collisionSlug(long, new Set());
    expect(first.length).toBe(64);
    const second = collisionSlug(long, new Set([first]));
    expect(second.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
    expect(second.endsWith("-2")).toBe(true);
  });
});
