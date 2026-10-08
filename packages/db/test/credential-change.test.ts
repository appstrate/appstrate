// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { _authHookSlotsForTesting } from "../src/auth.ts";
import {
  CREDENTIAL_CHANGE_REVOCATION_FAILED,
  endOtherAccessAfterCredentialChange,
} from "../src/credential-change.ts";

describe("endOtherAccessAfterCredentialChange", () => {
  it("fails the request with its own code when a step fails", async () => {
    const sessions = { deleteSessions: async () => undefined };
    const account = { id: `user-${crypto.randomUUID()}`, email: "nobody@example.test" };
    const slot = _authHookSlotsForTesting.credentialChange;
    const previous = slot.swapForTesting(async () => {
      throw new Error("revocation store unavailable");
    });
    try {
      const err = await endOtherAccessAfterCredentialChange(sessions, account, null).then(
        () => null,
        (e: unknown) => e as { statusCode?: number; body?: { code?: string } },
      );

      expect(err).not.toBeNull();
      expect(err!.statusCode).toBe(500);
      expect(err!.body?.code).toBe(CREDENTIAL_CHANGE_REVOCATION_FAILED);
    } finally {
      slot.swapForTesting(previous);
    }
  });
});
