// SPDX-License-Identifier: Apache-2.0

/**
 * The role-and-ceiling half of the offer door (`callerMayOffer`): an owner or
 * admin user credential unconfined to spaces whose scope ceiling leaves
 * `<type>:share`.
 */

import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { callerMayOffer } from "../../src/lib/package-access.ts";
import type { AppEnv } from "../../src/types/index.ts";

function ctxOf(values: Record<string, unknown>): Context<AppEnv> {
  return { get: (key: string) => values[key] } as unknown as Context<AppEnv>;
}

const admin = { principalKind: "user", orgId: "org", orgRole: "admin" };

describe("callerMayOffer", () => {
  it("admits an admin user credential with no ceiling", () => {
    expect(callerMayOffer(ctxOf(admin), "agent")).toBe(true);
  });

  it("refuses a ceiling that lacks the type's share", () => {
    const ceiling = new Set(["agents:read", "skills:share"]);
    expect(callerMayOffer(ctxOf({ ...admin, scopeCeiling: ceiling }), "agent")).toBe(false);
    expect(callerMayOffer(ctxOf({ ...admin, scopeCeiling: ceiling }), "skill")).toBe(true);
  });

  it("refuses a plain member, a delegate and a confined credential", () => {
    expect(callerMayOffer(ctxOf({ ...admin, orgRole: "member" }), "agent")).toBe(false);
    expect(callerMayOffer(ctxOf({ ...admin, principalKind: "delegate" }), "agent")).toBe(false);
    expect(callerMayOffer(ctxOf({ ...admin, credentialSpaceIds: ["spc_1"] }), "agent")).toBe(false);
  });
});
