// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  CREDENTIAL_CHANGE_REVOCATION_FAILED,
  endOtherAccessAfterCredentialChange,
} from "@appstrate/db/credential-change";

describe("endOtherAccessAfterCredentialChange", () => {
  it("fails the request with its own code when ending a session fails", async () => {
    const sessions = {
      listSessions: async () => [
        { id: "kept", token: "kept-token" },
        { id: "other", token: "other-token" },
      ],
      deleteSessions: async () => {
        throw new Error("session store unavailable");
      },
    };

    const err = await endOtherAccessAfterCredentialChange(sessions, "user-1", "kept").then(
      () => null,
      (e: unknown) => e as { statusCode?: number; body?: { code?: string } },
    );

    expect(err).not.toBeNull();
    expect(err!.statusCode).toBe(500);
    expect(err!.body?.code).toBe(CREDENTIAL_CHANGE_REVOCATION_FAILED);
  });
});
