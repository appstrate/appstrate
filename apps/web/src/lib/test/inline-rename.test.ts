// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { commitRename } from "../inline-rename.ts";

describe("commitRename", () => {
  it("saves the trimmed draft when it differs from the stored name", async () => {
    const saved: string[] = [];
    const outcome = await commitRename("  New name ", "Old name", (next) => {
      saved.push(next);
    });
    expect(outcome).toBe("saved");
    expect(saved).toEqual(["New name"]);
  });

  it("saves nothing when the trimmed draft is unchanged or blank", async () => {
    const saved: string[] = [];
    const save = (next: string) => {
      saved.push(next);
    };
    expect(await commitRename(" Same ", "Same", save)).toBe("unchanged");
    expect(await commitRename("   ", "Same", save)).toBe("unchanged");
    expect(saved).toEqual([]);
  });

  it("reports a refused save so the field keeps its draft", async () => {
    const outcome = await commitRename("New", "Old", async () => {
      throw new Error("refused");
    });
    expect(outcome).toBe("failed");
  });
});
