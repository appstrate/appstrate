// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { sectionWriteState } from "../schedule-options";

interface WriteState {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  variables: { name: string };
}
const saved: WriteState = {
  isPending: false,
  isSuccess: true,
  isError: false,
  variables: { name: "x" },
};

describe("sectionWriteState", () => {
  it("says a write in the section it was made from", () => {
    expect(sectionWriteState(saved, "general", "general")).toBe(saved);
  });

  it("keeps every other section quiet, the write itself untouched", () => {
    expect(sectionWriteState(saved, "general", "recurrence")).toEqual({
      ...saved,
      isSuccess: false,
    });
    const pending: WriteState = { ...saved, isSuccess: false, isPending: true };
    expect(sectionWriteState(pending, null, "general").isPending).toBe(false);
  });
});
