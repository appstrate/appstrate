// SPDX-License-Identifier: Apache-2.0

/**
 * Nothing registered after `GET /api/packages/:scope/:name/:version/download`
 * may share its shape.
 *
 * That route takes a PARAMETER in the act slot of the untyped package family
 * (`/api/packages/{scope}/{name}/<act>`), so it matches every `GET` whose
 * fourth segment is the literal `download`. Hono matches in REGISTRATION order
 * and has no specificity rule, so such an act registered after it is dead:
 * unreachable, with no error, no failing request and nothing in a diff to see
 * — the shadowed route simply never runs.
 *
 * No act has that shape today. The guard exists because the family keeps
 * growing (`home` and `shares` are the newest), each new one is written by
 * copying its neighbour, and a paragraph in `routes/packages.ts` is the only
 * other thing standing between the next author and a silently dead route.
 */

import { describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { SCOPED_PACKAGE_ROUTE } from "../../../src/routes/scoped-package-route.ts";

/**
 * The parameterised route every act of this family has to be registered before.
 * Built from the same constant the routes are, so a change to the scope/name
 * pattern cannot leave this guard silently matching nothing.
 */
const CATCH_ALL = `/api/packages/${SCOPED_PACKAGE_ROUTE}/:version/download`;

describe("the untyped package act family", () => {
  it("registers no GET shadowed by `:version/download`", () => {
    const routes = getTestApp().routes.filter((route) => route.method === "GET");
    const catchAllAt = routes.findIndex((route) => route.path === CATCH_ALL);
    expect(catchAllAt, `${CATCH_ALL} is not registered — this guard is watching nothing`).not.toBe(
      -1,
    );

    // A path this route would match: an act slot plus the literal `download`
    // under the same scope/name prefix. Anything registered BEFORE it is the
    // supported order, and its own registration is excluded.
    const prefix = `/api/packages/${SCOPED_PACKAGE_ROUTE}/`;
    const shadowed = routes
      .slice(catchAllAt + 1)
      .map((route) => route.path)
      .filter((path) => path.startsWith(prefix) && path.endsWith("/download"))
      .filter((path) => !path.slice(prefix.length, -"/download".length).includes("/"))
      .filter((path) => path !== CATCH_ALL);

    // Empty list, not a count: a regression names the route it killed.
    expect(shadowed).toEqual([]);
  });
});
