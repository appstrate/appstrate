// SPDX-License-Identifier: Apache-2.0

/**
 * The pairing request is what decides who owns the subscription it produces.
 * The server defaults `owner_type` to `org`, so a body that leaves it out turns
 * a member's personal pairing into a 403, and a reconnect naming the wrong owner
 * into a 404: every payload is pinned here.
 */

import { describe, it, expect } from "bun:test";
import { hasOrgSubscription, pairingRequestBody } from "../oauth-pairing.ts";

describe("pairingRequestBody", () => {
  it("pairs a new organization subscription", () => {
    expect(pairingRequestBody({ providerId: "claude-code", ownerType: "org" })).toEqual({
      providerId: "claude-code",
      owner_type: "org",
    });
  });

  it("pairs a new personal subscription", () => {
    expect(pairingRequestBody({ providerId: "codex", ownerType: "user" })).toEqual({
      providerId: "codex",
      owner_type: "user",
    });
  });

  it("reconnects an organization subscription in place", () => {
    expect(
      pairingRequestBody({ providerId: "claude-code", ownerType: "org", credentialId: "cred_org" }),
    ).toEqual({ providerId: "claude-code", owner_type: "org", credentialId: "cred_org" });
  });

  it("reconnects the caller's own subscription in place", () => {
    expect(
      pairingRequestBody({ providerId: "codex", ownerType: "user", credentialId: "cred_mine" }),
    ).toEqual({ providerId: "codex", owner_type: "user", credentialId: "cred_mine" });
  });

  it("sends no credentialId key for a new connection", () => {
    expect("credentialId" in pairingRequestBody({ providerId: "codex", ownerType: "user" })).toBe(
      false,
    );
  });
});

describe("hasOrgSubscription", () => {
  const subscription = {
    authMode: "oauth2",
    providerId: "claude-code",
    owner_type: "org",
    needs_reconnection: false,
  } as const;

  it("counts a healthy organization subscription of the provider", () => {
    expect(hasOrgSubscription([subscription], "claude-code")).toBe(true);
  });

  it("ignores a member's personal subscription, which serves no organization model", () => {
    expect(hasOrgSubscription([{ ...subscription, owner_type: "user" }], "claude-code")).toBe(
      false,
    );
  });

  it("ignores a subscription that needs reconnecting, another provider's, and an API key", () => {
    expect(hasOrgSubscription([{ ...subscription, needs_reconnection: true }], "claude-code")).toBe(
      false,
    );
    expect(hasOrgSubscription([subscription], "codex")).toBe(false);
    expect(hasOrgSubscription([{ ...subscription, authMode: "api_key" }], "claude-code")).toBe(
      false,
    );
    expect(hasOrgSubscription(undefined, "claude-code")).toBe(false);
  });
});
