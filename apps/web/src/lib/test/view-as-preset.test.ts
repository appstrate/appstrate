// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseViewAsPreset, viewAsPresetParam } from "../view-as-preset";

describe("view-as preset", () => {
  it("round-trips an organization role and a space role", () => {
    for (const preset of [
      { kind: "org", role: "member" },
      { kind: "org", role: "guest" },
      { kind: "space", key: "viewer" },
      { kind: "space", key: "support-lead" },
    ] as const) {
      expect(parseViewAsPreset(viewAsPresetParam(preset))).toEqual(preset);
    }
  });

  it("reads the bare parameter and anything unreadable as no preset", () => {
    for (const raw of [null, "", "1", "space:", "org:owner", "org:admin", "team:viewer"]) {
      expect(parseViewAsPreset(raw)).toBeNull();
    }
  });
});
