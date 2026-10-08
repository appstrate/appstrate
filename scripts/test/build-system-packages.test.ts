// SPDX-License-Identifier: Apache-2.0

/**
 * The `schema_version` guard of `build:system-packages` (the allowlist rule it also runs is
 * `findUnboundedInjectedCredentials`, tested in `packages/core/test/integration.test.ts`).
 *
 * Driven from synthetic manifests, not the repo's sources: the gate must hold
 * whatever version the tree happens to be at. A guard that stops comparing
 * passes everything, so each rejection is paired with an accepted case. The
 * last block pins tenant hosts the real sources' wildcards must keep reaching.
 */

import { describe, it, expect } from "bun:test";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import { findSchemaVersionDrift } from "../build-system-packages.ts";
import {
  matchesAuthorizedUriSpec,
  wildcardMatchStaysWithinBound,
} from "@appstrate/afps-shared/authorized-uris";

const manifest = (schemaVersion?: unknown) => ({
  name: "@appstrate/zoom",
  version: "1.0.0",
  type: "integration",
  ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }),
});

const DIR = "integration-zoom-1.0.0";
/** The drift a single source dir declaring `schemaVersion` reports. */
const driftOf = (schemaVersion: unknown) =>
  findSchemaVersionDrift([[DIR, manifest(schemaVersion)]]);

describe("findSchemaVersionDrift", () => {
  it("accepts a manifest declaring AFPS_SCHEMA_VERSION", () => {
    expect(driftOf(AFPS_SCHEMA_VERSION)).toEqual([]);
  });

  it("rejects any other value, a later minor and a non-string included", () => {
    // Strict equality: the number 0.3 is not the string "0.3".
    for (const declared of ["0.4", "1.0", Number(AFPS_SCHEMA_VERSION)]) {
      expect(driftOf(declared)).toEqual([{ dirName: DIR, declared }]);
    }
  });

  it("reports every offender, not just the first, and skips the conforming ones", () => {
    // It runs before `validateManifest`, so a file that is not an object at
    // all (`null`, an array) must report as missing rather than throw.
    expect(
      findSchemaVersionDrift([
        ["integration-a-1.0.0", manifest("0.1")],
        ["integration-b-1.0.0", manifest(AFPS_SCHEMA_VERSION)],
        ["mcp-server-c-1.0.0", manifest()],
        ["integration-d-1.0.0", manifest("0.2")],
        ["integration-e-1.0.0", null],
        ["integration-f-1.0.0", []],
      ]),
    ).toEqual([
      { dirName: "integration-a-1.0.0", declared: "0.1" },
      { dirName: "mcp-server-c-1.0.0", declared: undefined },
      { dirName: "integration-d-1.0.0", declared: "0.2" },
      { dirName: "integration-e-1.0.0", declared: undefined },
      { dirName: "integration-f-1.0.0", declared: undefined },
    ]);
  });
});

type Source = { auths?: Record<string, { authorized_uris?: string[] }> };
const SOURCES = `${import.meta.dir}/../system-packages`;
const wildcards: string[] = [];
for (const path of new Bun.Glob("*/manifest.json").scanSync({ cwd: SOURCES })) {
  const manifest = (await Bun.file(`${SOURCES}/${path}`).json()) as Source;
  for (const auth of Object.values(manifest.auths ?? {})) {
    wildcards.push(...(auth.authorized_uris ?? []).filter((uri) => uri.includes("*.")));
  }
}

describe("system package sources — tenant hosts under their wildcards", () => {
  // A failure here means the Public Suffix List moved under a system integration.
  it.each([
    "https://acme.zendesk.com/api/v2/tickets",
    "https://acme.my.salesforce.com/services/data/v61.0",
    "https://x.lightning.force.com/services/data",
    "https://org.crm4.dynamics.com/api/data/v9.2",
    "https://org.api.crm4.dynamics.com/api/data/v9.2",
    "https://us1.api.mailchimp.com/3.0/lists",
    "https://acme.freshdesk.com/api/v2/tickets",
    "https://acme.myfreshworks.com/crm/sales/api/contacts",
    "https://acme.freshsales.io/api/contacts",
    "https://acme.teamwork.com/projects.json",
    "https://acme.pipedrive.com/api/v1/deals",
    "https://app-eu.wrike.com/api/v4/tasks",
  ])("keeps the credential of %s", (url) => {
    const host = new URL(url).hostname;
    expect(
      wildcards.some(
        (uri) => matchesAuthorizedUriSpec(uri, url) && wildcardMatchStaysWithinBound(uri, host),
      ),
    ).toBe(true);
  });
});
