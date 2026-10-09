// SPDX-License-Identifier: Apache-2.0

/**
 * The persisted connection snapshot (`runs.resolved_connections`) and its causes
 * (`runs.integrations_unbound`) each have ONE shape, and their schema is what every
 * read seam parses them with: a row that drifted must fail there.
 */

import { describe, it, expect } from "bun:test";
import {
  CONNECTION_RESOLUTION_SOURCES,
  CONNECTION_RESOLUTION_WARNING_CODES,
  resolvedConnectionMapSchema,
  runIntegrationsUnboundSchema,
  type ResolvedConnectionMap,
  type RunIntegrationUnbound,
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

describe("runIntegrationsUnboundSchema", () => {
  it("accepts every warning code, and the layer on an explicit none", () => {
    const recorded: RunIntegrationUnbound[] = [
      ...CONNECTION_RESOLUTION_WARNING_CODES.map((code) => ({
        integrationId: `@acme/${code}`,
        code,
      })),
      { integrationId: "@acme/pinned", code: "integration_unbound", source: "member_pin" },
    ];
    expect(runIntegrationsUnboundSchema.parse(recorded)).toEqual(recorded);
  });

  it("refuses a bare id list, an unknown code or an unknown layer", () => {
    for (const raw of [
      ["@acme/slack"],
      [{ integrationId: "@acme/slack", code: "unbound" }],
      [{ integrationId: "@acme/slack", code: "integration_unbound", source: "pin" }],
    ]) {
      expect(() => runIntegrationsUnboundSchema.parse(raw)).toThrow();
    }
  });
});
