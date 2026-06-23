// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Regression guard for the `alg:none` id_token synthesis in codex-binary.ts.
 *
 * The Codex CLI requires `tokens.id_token` to be a parseable JWT to BOOT, but it
 * sends only `tokens.access_token` (the REAL subscription token) outbound as the
 * `Authorization: Bearer`. We therefore synthesise a syntactically-valid but
 * UNSIGNED (`alg:none`) id_token that never leaves the container — it satisfies
 * the local boot parse and forges no upstream identity.
 *
 * This correctness rests on the pinned Codex CLI version NEVER transmitting the
 * id_token (only the access_token). This test:
 *   (a) asserts the built auth.json id_token is `alg:none` and that the value
 *       used as the outbound Bearer is the access_token, never the id_token, and
 *   (b) pins the `@openai/codex` (codex-cli) version the behaviour was validated
 *       against — read from package.json — so a version bump trips this test and
 *       forces re-validation that the new CLI still never sends the id_token.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexAuthJson } from "../src/codex-binary.ts";

/** The codex-cli version the alg:none / access_token-only behaviour was validated against. */
const VALIDATED_CODEX_VERSION = "~0.141.0";

describe("codex alg:none id_token (CLI-version regression)", () => {
  it("pins the @openai/codex version the behaviour was validated against", () => {
    // Read straight from package.json. A bump there (peer or dev) trips this
    // test and forces re-validating that the new CLI still never sends id_token.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const peer = pkg.peerDependencies?.["@openai/codex"];
    const dev = pkg.devDependencies?.["@openai/codex"];
    expect(peer).toBe(VALIDATED_CODEX_VERSION);
    expect(dev).toBe(VALIDATED_CODEX_VERSION);
  });

  it("builds an alg:none id_token that is never the outbound Bearer (only access_token is)", () => {
    const ACCESS = "tok-real-access-SECRET-1234567890";
    const auth = buildCodexAuthJson({
      accessToken: ACCESS,
      accountId: "acct-123",
      nowMs: 1_700_000_000_000,
    });

    // (a) The id_token header is alg:none — an unsigned, local-only JWT.
    const parts = auth.tokens.id_token.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as {
      alg?: string;
      typ?: string;
    };
    expect(header.alg).toBe("none");
    expect(header.typ).toBe("JWT");

    // (b) The outbound Bearer is the REAL access_token, NOT the id_token. The CLI
    // sends `tokens.access_token` verbatim as the Authorization header; assert
    // the access_token is exactly the vended token and the id_token differs from
    // it (so the unsigned local token can never be what egresses).
    expect(auth.tokens.access_token).toBe(ACCESS);
    expect(auth.tokens.id_token).not.toBe(ACCESS);
    expect(auth.tokens.id_token).not.toContain(ACCESS);
  });

  it("keeps a far-future exp so the CLI never refreshes (would hit the real auth server)", () => {
    const now = 1_700_000_000_000;
    const auth = buildCodexAuthJson({ accessToken: "x-access-token", nowMs: now });
    const payload = JSON.parse(
      Buffer.from(auth.tokens.id_token.split(".")[1]!, "base64url").toString(),
    ) as { exp?: number };
    expect(payload.exp).toBeGreaterThan(Math.floor(now / 1000) + 300 * 24 * 3600);
  });
});
