// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon-wide orphan sweep's reclaim policy (#1130).
 *
 * `appstrate.managed=true` marks a per-run resource but identifies no
 * owner: every Appstrate process on the host writes it. A sweep keyed on
 * that label alone force-removed live agents and sidecars belonging to a
 * sibling instance. These cases pin the predicate that replaced it —
 * reclaim only what is provably finished — without needing a daemon.
 */

import { describe, expect, it } from "bun:test";
import { getEnv } from "@appstrate/env";
import { isReclaimableContainer } from "../../../src/services/docker.ts";

const NOW = 1_800_000_000_000;

/** A listing row `age` seconds old, in the given lifecycle state. */
function container(state: string, ageSeconds = 0) {
  return { State: state, Created: NOW / 1000 - ageSeconds };
}

describe("isReclaimableContainer", () => {
  it("reclaims inert residue", () => {
    expect(isReclaimableContainer(container("exited"), NOW)).toBe(true);
    expect(isReclaimableContainer(container("dead"), NOW)).toBe(true);
  });

  it("never reclaims a live workload, however old", () => {
    for (const state of ["running", "paused", "restarting", "removing"]) {
      expect(isReclaimableContainer(container(state), NOW)).toBe(false);
      expect(isReclaimableContainer(container(state, 86_400), NOW)).toBe(false);
    }
  });

  it("never reclaims a state this Engine version does not know", () => {
    // Fail closed: an unrecognised state is not a proof of termination.
    expect(isReclaimableContainer(container("some-future-state", 86_400), NOW)).toBe(false);
  });

  it("preserves a container still being provisioned by a sibling", () => {
    // The window between createWorkload and startWorkload is sub-second.
    expect(isReclaimableContainer(container("created", 1), NOW)).toBe(false);
  });

  it("reclaims a created container past the run boot deadline", () => {
    // No run may still be provisioning past this point — the platform's own
    // liveness contract says so — and `POST /stop` cannot make a `created`
    // container terminal, so nothing else would ever reclaim it.
    const deadline = getEnv().RUN_BOOT_DEADLINE_SECONDS;
    expect(isReclaimableContainer(container("created", deadline - 1), NOW)).toBe(false);
    expect(isReclaimableContainer(container("created", deadline + 1), NOW)).toBe(true);
  });
});
