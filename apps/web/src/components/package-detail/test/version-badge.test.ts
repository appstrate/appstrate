// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { versionBadges } from "../version-badge.ts";

const agent = { type: "agent" as const, source: "local", isHistoricalVersion: false };

describe("versionBadges — packages", () => {
  const skill = { type: "skill" as const, source: "local", isHistoricalVersion: false };

  it("names the version, and says when the draft has moved past it", () => {
    expect(versionBadges({ ...skill, version: "1.2.0" })).toEqual([
      { kind: "version", version: "1.2.0" },
    ]);
    expect(versionBadges({ ...skill, version: "1.2.0", hasUnarchivedChanges: true })).toEqual([
      { kind: "version", version: "1.2.0" },
      { kind: "modified" },
    ]);
  });

  it("marks a pinned version read-only, never modified", () => {
    const pinned = { ...skill, version: "1.0.0", isHistoricalVersion: true };
    expect(versionBadges({ ...pinned, hasUnarchivedChanges: true })).toEqual([
      { kind: "version", version: "1.0.0" },
      { kind: "readOnly" },
    ]);
  });

  it("says nothing of an unversioned package", () => {
    expect(versionBadges(skill)).toEqual([]);
  });
});

describe("versionBadges — agents", () => {
  it("shows a draft while the comparison is read, then once it differs or nothing is published", () => {
    expect(versionBadges({ ...agent, version: "1.0.0", draftVerdictPending: true })).toEqual([
      { kind: "draftPending" },
    ]);
    const changed = { ...agent, version: "1.0.0", hasUnarchivedChanges: true };
    expect(versionBadges(changed)).toEqual([{ kind: "draft" }]);
    expect(versionBadges(agent)).toEqual([{ kind: "draft" }]);
  });

  it("shows the version when the draft says what it already says", () => {
    expect(versionBadges({ ...agent, version: "1.0.0" })).toEqual([
      { kind: "version", version: "1.0.0" },
    ]);
  });

  it("shows the published version to a reader of it, and of a system agent, once", () => {
    expect(versionBadges({ ...agent, version: "2.0.0", readsPublished: true })).toEqual([
      { kind: "version", version: "2.0.0" },
    ]);
    expect(
      versionBadges({ ...agent, source: "system", version: "2.0.0", readsPublished: true }),
    ).toEqual([{ kind: "version", version: "2.0.0" }]);
  });

  it("combines the version and read-only in one badge for a pinned version", () => {
    expect(versionBadges({ ...agent, version: "0.9.0", isHistoricalVersion: true })).toEqual([
      { kind: "readOnlyVersion", version: "0.9.0" },
    ]);
  });
});
