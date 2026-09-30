// SPDX-License-Identifier: Apache-2.0

/**
 * The `schema_version` and `allow_all_uris` guards of `build:system-packages`.
 *
 * Driven from synthetic manifests, not the repo's sources: the gate must hold
 * whatever version the tree happens to be at. A guard that stops comparing
 * passes everything, so each rejection is paired with an accepted case.
 */

import { describe, it, expect } from "bun:test";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import {
  findAllowAllInjectedCredential,
  findSchemaVersionDrift,
} from "../build-system-packages.ts";

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

/** An integration whose `primary` auth carries `auth`. */
const withAuth = (auth: unknown) => ({ name: "@appstrate/zoom", auths: { primary: auth } });
const HTTP = { http: { in: "header", name: "Authorization", value: "{$credential.token}" } };

describe("findAllowAllInjectedCredential", () => {
  it("accepts an injected credential bound by authorized_uris, templated or literal", () => {
    for (const authorized_uris of [["https://api.zoom.us/**"], ["{$credential.site_url}/**"]]) {
      expect(
        findAllowAllInjectedCredential([[DIR, withAuth({ authorized_uris, delivery: HTTP })]]),
      ).toEqual([]);
    }
  });

  it("accepts allow_all_uris when nothing is injected over http", () => {
    for (const delivery of [undefined, { env: { TOKEN: { value: "{$credential.token}" } } }]) {
      expect(
        findAllowAllInjectedCredential([[DIR, withAuth({ allow_all_uris: true, delivery })]]),
      ).toEqual([]);
    }
  });

  it("rejects delivery.http under allow_all_uris, even next to an authorized_uris list", () => {
    const auth = {
      authorized_uris: ["https://*.api-us1.com/**"],
      allow_all_uris: true,
      delivery: HTTP,
    };
    expect(findAllowAllInjectedCredential([[DIR, withAuth(auth)]])).toEqual([
      { dirName: DIR, authKey: "primary" },
    ]);
  });

  it("reports every offending auth, and skips manifests without auths", () => {
    expect(
      findAllowAllInjectedCredential([
        [
          "integration-a-1.0.0",
          {
            auths: {
              primary: { allow_all_uris: true, delivery: HTTP },
              secondary: { allow_all_uris: false, delivery: HTTP },
              tertiary: { allow_all_uris: true, delivery: HTTP },
            },
          },
        ],
        ["mcp-server-b-1.0.0", { name: "@appstrate/b" }],
        ["integration-c-1.0.0", null],
        ["integration-d-1.0.0", { auths: { primary: null } }],
      ]),
    ).toEqual([
      { dirName: "integration-a-1.0.0", authKey: "primary" },
      { dirName: "integration-a-1.0.0", authKey: "tertiary" },
    ]);
  });
});
