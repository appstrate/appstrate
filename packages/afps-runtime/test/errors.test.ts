// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Coverage for what SURVIVES in `@appstrate/afps-runtime/errors`.
 *
 * The previous `errors.test.ts` was deleted with the five unraised error
 * classes and the `isAfpsError` marker it mostly asserted (see the CHANGELOG's
 * "Removed — five unraised error classes" entry). Three of its assertions
 * covered code that did NOT go away and were lost with it:
 *
 *   - `AuthorizedUrisError`'s code, and that `details` preserves `provider`
 *     and `target`. That object IS the allowlist-refusal audit record — the
 *     only place the refused target is written down — so a change that stopped
 *     carrying it would be a silent loss of security evidence.
 *   - `AfpsRuntimeError` forwards `ErrorOptions.cause`.
 *   - `AfpsRuntimeError` leaves `details` undefined when none is given.
 */

import { describe, it, expect } from "bun:test";
import { AuthorizedUrisError, ResolverError } from "../src/errors.ts";

describe("AuthorizedUrisError", () => {
  it("exposes the code it was constructed with", () => {
    expect(new AuthorizedUrisError("AUTHORIZED_URIS_EMPTY", "x").code).toBe(
      "AUTHORIZED_URIS_EMPTY",
    );
    expect(new AuthorizedUrisError("AUTHORIZED_URIS_MISMATCH", "x").code).toBe(
      "AUTHORIZED_URIS_MISMATCH",
    );
    expect(new AuthorizedUrisError("AUTHORIZED_URIS_EMPTY", "x").name).toBe("AuthorizedUrisError");
  });

  it("preserves the security-relevant target + provider in details", () => {
    const err = new AuthorizedUrisError("AUTHORIZED_URIS_MISMATCH", "rejected", {
      provider: "@appstrate/gmail",
      target: "https://evil.com/",
    });
    expect(err.details).toEqual({ provider: "@appstrate/gmail", target: "https://evil.com/" });
  });
});

describe("AfpsRuntimeError base, through the classes that actually reach it", () => {
  // Asserted on both concrete classes on purpose: the base's `options`
  // parameter is only worth having if a subclass forwards it, and both did
  // NOT — they called `super(message, details)` with no third argument, which
  // made the whole `cause` capability unreachable.
  it("forwards ErrorOptions.cause", () => {
    const root = new Error("root");

    const resolver = new ResolverError("RESOLVER_BODY_INVALID", "wrapped", undefined, {
      cause: root,
    });
    expect(resolver.cause).toBe(root);

    const allowlist = new AuthorizedUrisError("AUTHORIZED_URIS_MISMATCH", "wrapped", undefined, {
      cause: root,
    });
    expect(allowlist.cause).toBe(root);
  });

  it("keeps cause out of the details bag", () => {
    const root = new Error("root");
    const err = new ResolverError("RESOLVER_BODY_INVALID", "wrapped", { size: 1 }, { cause: root });
    expect(err.details).toEqual({ size: 1 });
    expect(err.cause).toBe(root);
  });

  it("omits details when not provided", () => {
    const err = new ResolverError("RESOLVER_MISSING_REQUIRED", "x");
    expect(err.details).toBeUndefined();

    // NOT `Object.hasOwn(err, "details") === false`. `details` is a declared
    // class field and the package compiles at `target: "ESNext"`, so
    // `useDefineForClassFields` defines the own property regardless of the
    // constructor's `if (details !== undefined)` guard — it exists, holding
    // `undefined`. Pinned here so a future reader does not "fix" the guard on
    // a promise the field declaration never kept. What DOES hold, and is what
    // any serialiser sees, is that no key reaches the wire.
    expect(Object.hasOwn(err, "details")).toBe(true);
    expect(JSON.parse(JSON.stringify({ ...err }))).not.toHaveProperty("details");
  });
});
