// SPDX-License-Identifier: Apache-2.0

/**
 * Which space-role presets the `webhooks` resource reaches.
 *
 * A webhook is delivery configuration — a signed egress channel pointing at an
 * arbitrary URL, whose reads expose the signing secret's siblings and whose
 * writes redirect where run outcomes go. That is authoring, not operating, so
 * the space half stops at `admin`/`builder` and in particular withholds
 * `runner`: a preset that launches agents must not be able to read or redirect
 * the notifications those runs emit.
 *
 * Asserted here rather than against the merged matrix in
 * `apps/api/test/unit/permissions.test.ts`: the aggregated snapshot is a
 * process-wide singleton several suites reset, so a negative read from there
 * passes whether the contribution is absent or merely unloaded.
 */
import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import webhooksModule from "../../index.ts";

/** The single space-level contribution the webhooks module declares. */
function spaceContribution() {
  const entry = webhooksModule
    .permissionsContribution?.()
    .find((contribution) => contribution.resource === "webhooks");
  if (entry === undefined || entry.level !== "space") {
    throw new Error("the webhooks module declares no space-level contribution for `webhooks`");
  }
  return entry;
}

describe("webhooks RBAC contribution", () => {
  it("keeps every action to the two authoring presets", () => {
    const entry = spaceContribution();
    expect([...entry.actions].sort()).toEqual(["delete", "read", "write"]);
    expect(entry.presets).toEqual(["admin", "builder"]);
  });

  it("withholds `runner` — a preset that launches runs does not route them", () => {
    expect(spaceContribution().presets).not.toContain("runner");
  });

  it("names only presets the platform knows", () => {
    const known: readonly string[] = SPACE_ROLE_PRESETS;
    for (const preset of spaceContribution().presets) {
      expect(known.includes(preset), `webhooks names ${preset}`).toBe(true);
    }
  });
});
