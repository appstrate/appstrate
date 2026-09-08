// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The route harness authenticates by org role, so what it grants each role
 * decides which route tests can reach a route at all. This holds that answer
 * to the module's own `permissionsContribution()`: narrow a grant there and the
 * harness narrows with it, instead of the route tests passing against a copy
 * of the matrix that no longer matches what the platform aggregates.
 */

import { describe, expect, it } from "bun:test";
import { ORG_ROLES } from "@appstrate/core/permissions";
import eeModule from "../../src/index.ts";
import { permissionsForRole } from "../helpers/app.ts";

describe("test app permissions", () => {
  it("grants each org role exactly what the module contributes to it", () => {
    const contribution = eeModule.permissionsContribution?.() ?? [];
    expect(contribution.length).toBeGreaterThan(0);

    const expected = Object.fromEntries(
      ORG_ROLES.map((role) => [
        role,
        contribution
          .filter((entry) => entry.level === "org" && entry.grantTo.includes(role))
          .flatMap((entry) => entry.actions.map((action) => `${entry.resource}:${action}`))
          .sort(),
      ]),
    );

    const actual = Object.fromEntries(
      ORG_ROLES.map((role) => [role, [...permissionsForRole(role)].sort()]),
    );

    expect(actual).toEqual(expected);
  });
});
