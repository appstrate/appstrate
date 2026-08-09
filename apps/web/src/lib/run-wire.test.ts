// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { normalizeRunResolvedSkillVersions } from "./run-wire";

describe("normalizeRunResolvedSkillVersions", () => {
  test("restores the explicit null version on draft selections", () => {
    const run = normalizeRunResolvedSkillVersions({
      id: "run_1",
      resolved_skill_versions: {
        "@acme/research": { source: "draft" },
      },
    });

    expect(run).toEqual({
      id: "run_1",
      resolved_skill_versions: {
        "@acme/research": { source: "draft", version: null },
      },
    });
  });

  test("preserves published selections and a null map", () => {
    expect(
      normalizeRunResolvedSkillVersions({
        id: "run_2",
        resolved_skill_versions: {
          "@acme/research": { source: "version", version: "1.2.3" },
        },
      }).resolved_skill_versions,
    ).toEqual({
      "@acme/research": { source: "version", version: "1.2.3" },
    });

    expect(
      normalizeRunResolvedSkillVersions({
        id: "run_3",
        resolved_skill_versions: null,
      }).resolved_skill_versions,
    ).toBeNull();
  });
});
