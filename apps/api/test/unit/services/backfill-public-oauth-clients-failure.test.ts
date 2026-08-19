// SPDX-License-Identifier: Apache-2.0

/**
 * What the backfill script says when it never gets to look at the data.
 *
 * `scripts/maintenance/backfill-public-oauth-clients.ts` is the repair a
 * runtime error tells an operator to run, so its own failures must not surface
 * as a stack trace into `node_modules`. This covers the pure classifier the
 * script prints from — the shapes are the ones the drivers actually throw:
 * Drizzle wraps every query failure in a `DrizzleQueryError` whose message is
 * the SQL, and only the wrapped cause carries the SQLSTATE.
 */

import { describe, it, expect } from "bun:test";
import { explainBackfillFailure } from "../../../src/services/backfill-public-oauth-clients.ts";

/** A `DrizzleQueryError`-shaped wrapper: SQL in the message, driver error in `cause`. */
function wrapped(cause: unknown): Error {
  return new Error(
    'Failed query: select "id" from "integration_oauth_clients" where ... is null\nparams: ',
    { cause },
  );
}

/** A driver error: the code lives on the object, not in the message. */
function driverError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("explainBackfillFailure", () => {
  describe("missing table (42P01)", () => {
    const cause = driverError('relation "integration_oauth_clients" does not exist', "42P01");

    it("names the table and the two things that explain its absence", () => {
      const message = explainBackfillFailure(wrapped(cause));
      expect(message).toContain("integration_oauth_clients");
      expect(message).toContain("Appstrate platform database");
      expect(message).toContain("migrations");
      expect(message).toContain("DATABASE_URL");
    });

    it("says migrations apply themselves at boot, so the remedy is actionable", () => {
      expect(explainBackfillFailure(wrapped(cause))).toContain("boots");
    });

    it("reads the SQLSTATE through the wrapper, not just off the top-level error", () => {
      // The regression this guards: `err.code` is `undefined` on the
      // DrizzleQueryError, so a top-level-only check falls through to the
      // generic branch and prints the SELECT instead of the diagnosis.
      expect(wrapped(cause)).not.toHaveProperty("code");
      expect(explainBackfillFailure(wrapped(cause))).toContain("does not exist");
    });

    it("classifies the driver error thrown on its own, unwrapped", () => {
      expect(explainBackfillFailure(cause)).toContain("integration_oauth_clients");
    });

    it("finds the code however deep the cause chain goes", () => {
      expect(explainBackfillFailure(wrapped(wrapped(cause)))).toContain("migrations");
    });
  });

  describe("cannot connect", () => {
    // Every code here means the database was never reached or never opened:
    // refused, unresolvable, credentials rejected, no such database.
    const cases: [string, string][] = [
      ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"],
      ["ENOTFOUND", "getaddrinfo ENOTFOUND db.internal"],
      ["28P01", 'password authentication failed for user "appstrate"'],
      ["28000", "no pg_hba.conf entry for host"],
      ["3D000", 'database "appstrate" does not exist'],
    ];

    for (const [code, message] of cases) {
      it(`points at DATABASE_URL for ${code}`, () => {
        const explained = explainBackfillFailure(wrapped(driverError(message, code)));
        expect(explained).toContain("could not reach the database");
        expect(explained).toContain("DATABASE_URL");
        expect(explained).toContain(code);
      });
    }

    it("never echoes the connection string, even when the cause carries one", () => {
      // A wrong-key or wrong-URL run is realistic and this output gets pasted
      // into tickets, so the remedy names the variable and never its value.
      const leaky = driverError(
        "connect ECONNREFUSED postgres://appstrate:s3cr3t@db.internal:5432/appstrate",
        "ECONNREFUSED",
      );
      const explained = explainBackfillFailure(wrapped(leaky));
      expect(explained).not.toContain("s3cr3t");
      expect(explained).not.toContain("postgres://");
    });
  });

  describe("anything else", () => {
    it("carries the cause's own message rather than the wrapper's SQL", () => {
      expect(
        explainBackfillFailure(wrapped(new Error("CONNECTION_ENCRYPTION_KEY must be 32 bytes"))),
      ).toBe("backfill-public-oauth-clients: CONNECTION_ENCRYPTION_KEY must be 32 bytes");
    });

    it("collapses a multi-line message onto one line", () => {
      expect(explainBackfillFailure(new Error("first line\n  second line"))).toBe(
        "backfill-public-oauth-clients: first line second line",
      );
    });

    it("survives a thrown non-Error", () => {
      expect(explainBackfillFailure("plain string boom")).toBe(
        "backfill-public-oauth-clients: plain string boom",
      );
      // `undefined` has no message to lift, so the stringified value is all
      // there is — still prefixed, so the operator knows what printed it.
      expect(explainBackfillFailure(undefined)).toBe("backfill-public-oauth-clients: undefined");
    });

    it("does not classify an unrelated SQLSTATE as unreachable", () => {
      // 23505 is a real failure but not one of the two this script diagnoses;
      // it must reach the generic branch with its message intact.
      const explained = explainBackfillFailure(
        wrapped(driverError("duplicate key value violates unique constraint", "23505")),
      );
      expect(explained).toContain("duplicate key value");
      expect(explained).not.toContain("DATABASE_URL");
    });

    it("terminates on a cyclic cause chain instead of hanging the terminal", () => {
      const a = new Error("cycle a");
      const b = new Error("cycle b", { cause: a });
      (a as { cause?: unknown }).cause = b;
      // Returning at all is the property under test — an unbounded walk would
      // hang here and the suite would time out rather than fail. The assertion
      // then pins that the bounded walk still produced a real message; which of
      // the two the depth limit lands on is not a contract.
      expect(explainBackfillFailure(a)).toMatch(/^backfill-public-oauth-clients: cycle [ab]$/);
    });
  });
});
