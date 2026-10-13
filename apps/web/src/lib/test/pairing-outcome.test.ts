// SPDX-License-Identifier: Apache-2.0

/**
 * The redeem consumes the pairing first, then judges and writes the credential.
 * `consumed` alone is therefore not success: read as one, a refused redeem
 * toasts "connected" and a poll landing between consume and link skips the
 * onboarding's model seeding.
 */

import { describe, it, expect } from "bun:test";
import { PAIRING_LINK_WAIT_MS, pairingOutcome, pairingPollContinues } from "../pairing-outcome.ts";

const CONSUMED_UNLINKED = { status: "consumed", credentialId: null } as const;
const CONNECTED = { status: "consumed", credentialId: "cred_1" } as const;

describe("pairingOutcome", () => {
  it.each([
    ["no answer yet", undefined, 0, "waiting"],
    ["pending", { status: "pending", credentialId: null }, 0, "waiting"],
    ["pending, however long", { status: "pending", credentialId: null }, 60_000, "waiting"],
    ["expired", { status: "expired", credentialId: null }, 0, "expired"],
    ["consumed with its credential", CONNECTED, 0, "connected"],
    ["consumed with its credential, late", CONNECTED, PAIRING_LINK_WAIT_MS, "connected"],
    ["consumed, no credential, within the wait", CONSUMED_UNLINKED, 0, "waiting"],
    [
      "consumed, no credential, just under the wait",
      CONSUMED_UNLINKED,
      PAIRING_LINK_WAIT_MS - 1,
      "waiting",
    ],
    ["consumed, no credential, at the wait", CONSUMED_UNLINKED, PAIRING_LINK_WAIT_MS, "failed"],
    ["consumed, no credential, past it", CONSUMED_UNLINKED, PAIRING_LINK_WAIT_MS * 3, "failed"],
  ] as const)("%s", (_name, poll, elapsed, outcome) => {
    expect(pairingOutcome(poll, elapsed)).toBe(outcome);
  });
});

describe("pairingPollContinues", () => {
  it("keeps polling a consumed pairing until its credential shows", () => {
    expect(pairingPollContinues(undefined)).toBe(true);
    expect(pairingPollContinues({ status: "pending", credentialId: null })).toBe(true);
    expect(pairingPollContinues(CONSUMED_UNLINKED)).toBe(true);
  });

  it("stops on a connected or expired pairing", () => {
    expect(pairingPollContinues(CONNECTED)).toBe(false);
    expect(pairingPollContinues({ status: "expired", credentialId: null })).toBe(false);
  });
});
