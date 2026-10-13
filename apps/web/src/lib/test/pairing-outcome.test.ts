// SPDX-License-Identifier: Apache-2.0

/**
 * The redeem consumes the pairing first, then judges and writes the credential.
 * `consumed` alone is therefore not success: read as one, a refused redeem
 * toasts "connected" and a poll landing between consume and link skips the
 * onboarding's model seeding.
 */

import { describe, it, expect } from "bun:test";
import { pairingOutcome } from "../pairing-outcome.ts";

const CONSUMED_UNLINKED = { status: "consumed", credentialId: null } as const;
const CONNECTED = { status: "consumed", credentialId: "cred_1" } as const;

describe("pairingOutcome", () => {
  it.each([
    ["no answer yet", undefined, false, "waiting"],
    ["pending", { status: "pending", credentialId: null }, false, "waiting"],
    ["pending, wait elapsed", { status: "pending", credentialId: null }, true, "waiting"],
    ["expired", { status: "expired", credentialId: null }, false, "expired"],
    ["consumed with its credential", CONNECTED, false, "connected"],
    ["consumed with its credential, wait elapsed", CONNECTED, true, "connected"],
    ["consumed, no credential, within the wait", CONSUMED_UNLINKED, false, "waiting"],
    ["consumed, no credential, wait elapsed", CONSUMED_UNLINKED, true, "failed"],
  ] as const)("%s", (_name, poll, linkWaitElapsed, outcome) => {
    expect(pairingOutcome(poll, linkWaitElapsed)).toBe(outcome);
  });
});
