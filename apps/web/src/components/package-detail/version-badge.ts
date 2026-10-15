// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";

export type VersionBadge =
  | { kind: "version"; version: string }
  | { kind: "modified" }
  | { kind: "readOnly" }
  | { kind: "readOnlyVersion"; version: string }
  | { kind: "draft" }
  | { kind: "draftPending" };

/**
 * What the header says about the version on screen. A package can be both versioned and modified
 * since its draft is authoring state; an agent says one thing: its version, or that it is a draft.
 */
export function versionBadges(input: {
  type: PackageType;
  source: string;
  version?: string | null;
  /** The page shows the latest PUBLISHED version, not the draft. */
  readsPublished?: boolean;
  isHistoricalVersion: boolean;
  hasUnarchivedChanges?: boolean;
  /** The draft-vs-published comparison is still being read. */
  draftVerdictPending?: boolean;
}): VersionBadge[] {
  const { version, isHistoricalVersion } = input;
  if (input.type !== "agent") {
    const modified = input.hasUnarchivedChanges && !isHistoricalVersion;
    return [
      ...(version ? [{ kind: "version" as const, version }] : []),
      ...(modified ? [{ kind: "modified" as const }] : []),
      ...(isHistoricalVersion ? [{ kind: "readOnly" as const }] : []),
    ];
  }
  if (isHistoricalVersion) return version ? [{ kind: "readOnlyVersion", version }] : [];
  // A draft that says what the last published version already says is not worth a badge of its
  // own: the version is. "Draft" means it differs, or nothing is published.
  if (input.source !== "system" && !input.readsPublished) {
    if (input.draftVerdictPending) return [{ kind: "draftPending" }];
    if (input.hasUnarchivedChanges || !version) return [{ kind: "draft" }];
  }
  return version ? [{ kind: "version", version }] : [];
}
