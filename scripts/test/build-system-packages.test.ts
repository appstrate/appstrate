// SPDX-License-Identifier: Apache-2.0

/**
 * The `schema_version` guard of `build:system-packages` (the allowlist rule it also runs is
 * `findUnboundedInjectedCredentials`, tested in `packages/core/test/integration.test.ts`).
 *
 * Driven from synthetic manifests, not the repo's sources: the gate must hold
 * whatever version the tree happens to be at. A guard that stops comparing
 * passes everything, so each rejection is paired with an accepted case. The
 * last block reads the real sources, so a `tldts` bump fails in `bun test` too.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import {
  findUnboundedInjectedCredentials,
  findUnevaluableExpressions,
} from "@appstrate/core/integration";
import { findSchemaVersionDrift } from "../build-system-packages.ts";
// By path: the root workspace does not depend on (nor link) `@appstrate/afps-runtime`.
import { credentialStaysWithinBound } from "../../packages/afps-runtime/src/resolvers/credential-guard.ts";
import { matchesAuthorizedUriSpec } from "@appstrate/afps-shared/authorized-uris";

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

describe("system package sources — manifest write-path rules", () => {
  type Source = { auths?: Record<string, { authorized_uris?: string[] }> };
  const SOURCES = join(import.meta.dir, "../system-packages");
  const manifests = readdirSync(SOURCES)
    .filter((dir) => !dir.startsWith("."))
    .map((dir) => {
      const raw = readFileSync(join(SOURCES, dir, "manifest.json"), "utf8");
      return [dir, JSON.parse(raw) as Source] as const;
    });

  it("passes every manifest write-path rule, the authorized_uris host bound included", () => {
    const refused = manifests.flatMap(([dir, manifest]) =>
      [...findUnboundedInjectedCredentials(manifest), ...findUnevaluableExpressions(manifest)].map(
        (issue) => `${dir}: ${issue.path.join(".")}`,
      ),
    );
    expect(refused).toEqual([]);
  });

  it("still holds tenant wildcards under a registrable domain, so the sweep is not vacuous", () => {
    const uris = manifests.flatMap(([, manifest]) =>
      Object.values(manifest.auths ?? {}).flatMap((auth) => auth.authorized_uris ?? []),
    );
    expect(uris).toContain("https://*.zendesk.com/**");
    expect(uris).toContain("https://*.salesforce.com/**");
  });

  // A failure here means the Public Suffix List moved: rerun 0037.
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
  ])("keeps the credential of a tenant host its wildcard matches: %s", (url) => {
    const wildcards = manifests.flatMap(([, manifest]) =>
      Object.values(manifest.auths ?? {})
        .flatMap((auth) => auth.authorized_uris ?? [])
        .filter((uri) => uri.includes("*.")),
    );
    expect(wildcards.some((uri) => matchesAuthorizedUriSpec(uri, url))).toBe(true);
    expect(credentialStaysWithinBound(url, wildcards)).toBe(true);
  });
});
