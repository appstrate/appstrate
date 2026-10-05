// SPDX-License-Identifier: Apache-2.0

/**
 * The persisted connection snapshot (`runs.resolved_connections`) has ONE
 * shape, and `resolvedConnectionMapSchema` is what every read seam parses it
 * with: a row that drifted from {@link ResolvedConnectionMap} must fail there.
 */

import { describe, it, expect } from "bun:test";
import {
  CONNECTION_RESOLUTION_SOURCES,
  resolvedConnectionMapSchema,
  type ResolvedConnectionMap,
} from "../src/integration.ts";

const bound = {
  connectionId: "11111111-1111-1111-1111-111111111111",
  source: "member_pin",
  label: "Gmail Boulot",
  accountId: "dt@tractr.net",
} as const;

describe("resolvedConnectionMapSchema", () => {
  it("accepts the snapshot the resolver writes, for every cascade layer", () => {
    const snapshot: ResolvedConnectionMap = Object.fromEntries(
      CONNECTION_RESOLUTION_SOURCES.map((source) => [`@acme/${source}`, [{ ...bound, source }]]),
    );
    expect(resolvedConnectionMapSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("refuses an entry without its label or account, or with a source outside the cascade", () => {
    const { label: _label, ...unlabelled } = bound;
    const { accountId: _accountId, ...noAccount } = bound;
    for (const entry of [unlabelled, noAccount, { ...bound, source: "pin" }]) {
      expect(() => resolvedConnectionMapSchema.parse({ "@acme/gmail": [entry] })).toThrow();
    }
  });
});
