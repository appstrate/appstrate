// SPDX-License-Identifier: Apache-2.0

/**
 * The pairing request has two shapes, and the server refuses a mix of them:
 * a creation states `owner_type` (left out, it defaults to `org`, which turns a
 * member's personal pairing into a 403); a reconnect states `credentialId` alone
 * (`owner_type` beside it is a 400).
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import { hasOrgSubscription, pairingPollState, pairingRequestBody } from "../oauth-pairing.ts";

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

  it("reconnects a credential in place, naming it and no owner", () => {
    const body = pairingRequestBody({ providerId: "claude-code", credentialId: "cred_1" });
    expect(body).toEqual({ providerId: "claude-code", credentialId: "cred_1" });
    expect("owner_type" in body).toBe(false);
  });

  it("sends no credentialId key for a new connection", () => {
    expect("credentialId" in pairingRequestBody({ providerId: "codex", ownerType: "user" })).toBe(
      false,
    );
  });

  it("accepts no mix of the two shapes", () => {
    // @ts-expect-error a reconnect states no owner
    pairingRequestBody({ providerId: "codex", ownerType: "user", credentialId: "cred_1" });
    // @ts-expect-error a creation states its owner
    pairingRequestBody({ providerId: "codex" });
  });
});

describe("pairingPollState", () => {
  const unavailable = new ApiError("bad_gateway", "Bad gateway", 502);

  it("is pending until the server answers", () => {
    expect(pairingPollState(undefined, null)).toBe("pending");
  });

  it("is the status the server states", () => {
    for (const status of ["pending", "connected", "failed", "expired"] as const) {
      expect(pairingPollState(status, null)).toBe(status);
    }
  });

  // A deploy or a proxy answering 502 past the query's retry: the poll goes on.
  it("stays pending through a transient error", () => {
    expect(pairingPollState("pending", unavailable)).toBe("pending");
    expect(pairingPollState(undefined, unavailable)).toBe("pending");
    expect(pairingPollState("pending", new TypeError("Failed to fetch"))).toBe("pending");
  });

  it("keeps a terminal status through a transient error", () => {
    expect(pairingPollState("connected", unavailable)).toBe("connected");
  });

  it("is lost once the server refuses to state one, even over a cached pending", () => {
    for (const status of [401, 403, 404]) {
      const refusal = new ApiError("refused", "refused", status);
      expect(pairingPollState("pending", refusal)).toBe("lost");
      expect(pairingPollState(undefined, refusal)).toBe("lost");
    }
  });
});

describe("hasOrgSubscription", () => {
  const subscription = {
    authMode: "oauth2",
    providerId: "claude-code",
    bindable: true,
    needs_reconnection: false,
  } as const;

  it("counts a healthy subscription the server lists as bindable", () => {
    expect(hasOrgSubscription([subscription], "claude-code")).toBe(true);
  });

  it("ignores a subscription no organization model may bind, a member's own", () => {
    expect(hasOrgSubscription([{ ...subscription, bindable: false }], "claude-code")).toBe(false);
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
