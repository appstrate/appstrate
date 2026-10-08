// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { entriesToMetadata, metadataToEntries } from "../end-user-metadata.ts";

describe("end-user metadata form model", () => {
  it("builds the create payload from typed rows, dropping rows with no key", () => {
    expect(
      entriesToMetadata([
        { key: " plan ", value: "pro" },
        { key: "", value: "orphan" },
      ]),
    ).toEqual({ plan: "pro" });
  });

  it("round-trips an untouched non-string value as its own type", () => {
    const entries = metadataToEntries({ seats: 30, beta: true, note: "x" });
    expect(entriesToMetadata(entries)).toEqual({ seats: 30, beta: true, note: "x" });
  });
});
