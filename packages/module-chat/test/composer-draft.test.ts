// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { takesDraft } from "../src/ui/composer-draft.ts";

const DRAFT = "Crée un agent qui résume mes courriels";

describe("takesDraft", () => {
  it("seeds the first composer of the conversation", () => {
    expect(takesDraft(DRAFT, { seeded: false, typed: "" })).toBe(true);
  });

  it("does not put the draft back in the footer composer after the first send", () => {
    // The welcome composer took it and the send emptied the field: the footer
    // composer mounts on an empty field, in a conversation already seeded.
    expect(takesDraft(DRAFT, { seeded: true, typed: "" })).toBe(false);
  });

  it("never replaces what is typed, and has nothing to seed without a draft", () => {
    expect(takesDraft(DRAFT, { seeded: false, typed: "Bonjour" })).toBe(false);
    expect(takesDraft(undefined, { seeded: false, typed: "" })).toBe(false);
    expect(takesDraft("", { seeded: false, typed: "" })).toBe(false);
  });
});
