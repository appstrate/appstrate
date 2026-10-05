// SPDX-License-Identifier: Apache-2.0

/**
 * The org list is the one read that must survive a refused role preview: the
 * refusal ends the preview, and an empty org list would send a member to
 * onboarding instead of back to their own view.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({});
const { shouldRetryOrgList } = await import("../use-org.ts");

const refusedPersona = new ApiError("view_as_not_found", "space is gone", 404);

describe("shouldRetryOrgList", () => {
  it("asks once more after a refused persona", () => {
    expect(shouldRetryOrgList(0, refusedPersona)).toBe(true);
    expect(shouldRetryOrgList(1, refusedPersona)).toBe(false);
  });

  it("otherwise follows the shared rule", () => {
    expect(shouldRetryOrgList(0, new ApiError("not_found", "nope", 404))).toBe(false);
    expect(shouldRetryOrgList(0, new ApiError("unavailable", "later", 503))).toBe(true);
    expect(shouldRetryOrgList(1, new ApiError("unavailable", "later", 503))).toBe(false);
  });

  it("recovers the list when the first answer refuses the persona", async () => {
    const qc = new QueryClient();
    let asked = 0;
    const orgs = await qc.fetchQuery({
      queryKey: ["orgs"],
      queryFn: () => (asked++ === 0 ? Promise.reject(refusedPersona) : Promise.resolve(["org"])),
      retry: shouldRetryOrgList,
      retryDelay: 0,
    });
    expect(orgs).toEqual(["org"]);
    expect(asked).toBe(2);
  });
});
