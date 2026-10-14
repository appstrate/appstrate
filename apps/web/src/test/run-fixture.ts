// SPDX-License-Identifier: Apache-2.0

/**
 * The run the run surfaces' tests share. One fixture rather than a copy per
 * suite: several suites render the same run through different surfaces (the
 * table row, the card, the duration leaf), and a fixture that drifts between
 * them makes "the table shows it, the card does not" impossible to trust.
 */

import type { EnrichedRun } from "@appstrate/shared-types";

export const STARTED_AT = "2026-07-01T10:00:00.000Z";

/** A terminal run carrying every field a run surface can display. */
export function makeRun(overrides: Partial<EnrichedRun> = {}): EnrichedRun {
  return {
    id: "run_1",
    runNumber: 42,
    status: "success",
    packageId: "@acme/reporter",
    started_at: STARTED_AT,
    duration: 4200,
    error: null,
    file_counts: { input: 2, output: 1 },
    proxy_label: "eu-proxy",
    user_name: "Alice",
    package_ephemeral: true,
    token_usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
    },
    ...overrides,
  } as unknown as EnrichedRun;
}
