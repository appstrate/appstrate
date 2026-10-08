// SPDX-License-Identifier: Apache-2.0

/**
 * The space library's "impose in the chat" control: who may flip it, and what
 * a refusal says.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import { chatEnforceErrorKey } from "../chat-enforce-errors.ts";
import {
  mayConfigurePackage,
  maySetPackageActive,
  type SpaceGrant,
} from "../package-permissions.ts";

function grant(overrides: Partial<SpaceGrant> = {}): SpaceGrant {
  return { permissions: [], personal: false, access: "member", ...overrides };
}

describe("mayConfigurePackage", () => {
  it("is false while the space list has not resolved", () => {
    expect(mayConfigurePackage(undefined, "skill")).toBe(false);
  });

  it("asks for skills:write in the space for a skill", () => {
    expect(mayConfigurePackage(grant({ permissions: ["skills:write"] }), "skill")).toBe(true);
    expect(mayConfigurePackage(grant({ permissions: ["skills:read"] }), "skill")).toBe(false);
  });

  // The server waives the grant for the owner of a personal space on
  // activation only; `configure` is checked everywhere, so is this.
  it("grants no personal-space exemption", () => {
    const own = grant({ personal: true });
    expect(maySetPackageActive(own, "skill", true)).toBe(true);
    expect(mayConfigurePackage(own, "skill")).toBe(false);
  });
});

describe("chatEnforceErrorKey", () => {
  it("names the one refusal whose remedy depends on this surface", () => {
    expect(chatEnforceErrorKey(new ApiError("no_published_version", "refused", 409))).toBe(
      "library.chatEnforce.error.noPublishedVersion",
    );
  });

  it("leaves the limit and the budget to their code's own sentence", () => {
    expect(chatEnforceErrorKey(new ApiError("enforced_skills_limit", "x", 409))).toBeUndefined();
    expect(chatEnforceErrorKey(new ApiError("enforced_skills_budget", "x", 409))).toBeUndefined();
  });

  it("leaves any other failure to the server's own message", () => {
    expect(chatEnforceErrorKey(new ApiError("forbidden", "denied", 403))).toBeUndefined();
    expect(chatEnforceErrorKey(new ApiError("not_found", "gone", 404))).toBeUndefined();
    expect(chatEnforceErrorKey(new Error("network"))).toBeUndefined();
  });
});
