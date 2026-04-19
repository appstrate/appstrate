// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/jwt-identity.ts` — `decodeAccessTokenIdentity`.
 *
 * Contract:
 *   1. A well-formed JWT (header.payload.signature) whose base64url
 *      payload is a JSON object carrying a non-empty string `sub` +
 *      non-empty string `email` decodes to `{ userId, email }`.
 *      Extra claims (name, scope, …) are silently discarded.
 *   2. Any structural deviation — wrong part count, non-base64url
 *      payload, non-JSON payload, JSON primitive, missing / empty /
 *      non-string `sub` or `email` — throws a descriptive Error.
 *
 * Pure function: no HTTP, no keyring, no mocks needed. JWTs are
 * built in-test via `makeJwt()` below.
 */

import { describe, it, expect } from "bun:test";
import { decodeAccessTokenIdentity } from "../src/lib/jwt-identity.ts";

function makeJwt(payload: unknown, parts = 3): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "signature";
  return [header, body, sig].slice(0, parts).join(".");
}

describe("decodeAccessTokenIdentity", () => {
  it("returns { userId, email } for a JWT carrying sub + email", () => {
    const jwt = makeJwt({ sub: "user_abc", email: "alice@example.com" });
    expect(decodeAccessTokenIdentity(jwt)).toEqual({
      userId: "user_abc",
      email: "alice@example.com",
    });
  });

  it("ignores extra claims (name, scope, iat, …) and returns only userId + email", () => {
    const jwt = makeJwt({
      sub: "user_xyz",
      email: "bob@example.com",
      name: "Bob",
      scope: "cli",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(decodeAccessTokenIdentity(jwt)).toEqual({
      userId: "user_xyz",
      email: "bob@example.com",
    });
  });

  it("throws when the token has only 2 segments (missing signature)", () => {
    const jwt = makeJwt({ sub: "user_abc", email: "alice@example.com" }, 2);
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("Malformed access token — expected JWT");
  });

  it("throws when the token has 4 segments", () => {
    const jwt = `${makeJwt({ sub: "user_abc", email: "alice@example.com" })}.extra`;
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("Malformed access token — expected JWT");
  });

  it("throws when the payload is not valid base64url", () => {
    // `@` is not a valid base64url character — Buffer.from(…, 'base64url')
    // tolerates some things, so we pair it with a payload that cannot
    // round-trip to JSON to force the JSON.parse catch.
    const jwt = ["aaa", "@@@ not base64url @@@", "sig"].join(".");
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("payload is not valid base64url JSON");
  });

  it("throws when the payload is valid base64url but not valid JSON", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from("not json at all").toString("base64url");
    const jwt = [header, body, "sig"].join(".");
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("payload is not valid base64url JSON");
  });

  it("throws when the payload is a JSON string primitive", () => {
    const jwt = makeJwt("string");
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("payload is not an object");
  });

  it("throws when the payload is a JSON number primitive", () => {
    const jwt = makeJwt(42);
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("payload is not an object");
  });

  it("throws when the payload is JSON null", () => {
    const jwt = makeJwt(null);
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("payload is not an object");
  });

  it("throws `missing the sub claim` for an empty payload object", () => {
    const jwt = makeJwt({});
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `sub` claim");
  });

  it("throws `missing the sub claim` when sub is an empty string", () => {
    const jwt = makeJwt({ sub: "", email: "alice@example.com" });
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `sub` claim");
  });

  it("throws `missing the sub claim` when sub is a number", () => {
    const jwt = makeJwt({ sub: 123, email: "alice@example.com" });
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `sub` claim");
  });

  it("throws `missing the email claim` when email is absent", () => {
    const jwt = makeJwt({ sub: "user_abc" });
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `email` claim");
  });

  it("throws `missing the email claim` when email is an empty string", () => {
    const jwt = makeJwt({ sub: "user_abc", email: "" });
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `email` claim");
  });

  it("throws `missing the email claim` when email is null", () => {
    const jwt = makeJwt({ sub: "user_abc", email: null });
    expect(() => decodeAccessTokenIdentity(jwt)).toThrow("missing the `email` claim");
  });
});
