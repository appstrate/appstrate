// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { fieldKeyVerdict } from "../schema-field-key";

describe("fieldKeyVerdict", () => {
  it("refuses a key that slugs to nothing", () => {
    expect(fieldKeyVerdict("", [])).toEqual({ key: "", error: "editor.fieldKeyRequired" });
    expect(fieldKeyVerdict("  ", []).error).toBe("editor.fieldKeyRequired");
  });

  it("refuses a key another field holds, compared after slugging", () => {
    expect(fieldKeyVerdict("Due date", ["due-date"])).toEqual({
      key: "due-date",
      error: "editor.fieldKeyTaken",
    });
  });

  it("accepts a free key and returns it slugged", () => {
    expect(fieldKeyVerdict("Due date", ["title"])).toEqual({ key: "due-date", error: null });
  });
});
