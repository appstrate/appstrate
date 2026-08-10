// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { selectChatEngine } from "../src/pi-chat/engine-selection.ts";

describe("Pi chat engine selection", () => {
  it("keeps OAuth subscriptions on Pi regardless of the temporary allowlist", () => {
    expect(
      selectChatEngine({
        orgId: "org_oauth",
        subscription: true,
        configuredOrgIds: undefined,
      }),
    ).toBe("pi");
  });

  it("selects Pi for an API-key model only when the exact org id is allowlisted", () => {
    expect(
      selectChatEngine({
        orgId: "org_phase3",
        subscription: false,
        configuredOrgIds: " org_other, org_phase3 ,org_last ",
      }),
    ).toBe("pi");
    expect(
      selectChatEngine({
        orgId: "org_phase",
        subscription: false,
        configuredOrgIds: "org_phase3",
      }),
    ).toBe("ai-sdk");
  });

  it("defaults API-key models to AI SDK and refuses a global wildcard", () => {
    for (const configuredOrgIds of [undefined, "", "*", "org_other"]) {
      expect(
        selectChatEngine({
          orgId: "org_phase3",
          subscription: false,
          configuredOrgIds,
        }),
      ).toBe("ai-sdk");
    }
  });
});
