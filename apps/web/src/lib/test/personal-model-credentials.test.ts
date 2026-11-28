// SPDX-License-Identifier: Apache-2.0

/** The caller's own connections, out of the org-wide list a reader gets. */

import { describe, it, expect } from "bun:test";
import { ownPersonalCredentials } from "../personal-model-credentials.ts";

describe("ownPersonalCredentials", () => {
  const credentials: {
    id: string;
    owner_type: "org" | "user";
    owner_id: string | null;
  }[] = [
    { id: "mine", owner_type: "user", owner_id: "u_me" },
    { id: "theirs", owner_type: "user", owner_id: "u_other" },
    { id: "org", owner_type: "org", owner_id: null },
  ];

  it("keeps only the caller's personal credentials out of an org-wide list", () => {
    expect(ownPersonalCredentials(credentials, "u_me").map((c) => c.id)).toEqual(["mine"]);
  });

  it("keeps nothing while the caller is not known yet", () => {
    expect(ownPersonalCredentials(credentials, undefined)).toEqual([]);
  });
});
