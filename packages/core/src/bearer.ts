// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound `Authorization: Bearer …` parsing — the read side of the header
 * policy whose write side lives in `./oauth-bearer-swap.ts`.
 *
 * Lives in core rather than `apps/api/src/lib/` because the
 * `appstrate-runner` daemon (`apps/api/src/modules/firecracker/runner/`)
 * authenticates the same way and deliberately imports nothing outside its
 * own directory and `@appstrate/core/*` — it boots on a bare KVM host with
 * only the `FIRECRACKER_RUNNER_*` variables, so it cannot reach into the
 * platform lib.
 */

/**
 * Extract the token from an RFC 6750 `Authorization` header.
 *
 * RFC 6750 §2.1 inherits the `credentials` grammar from RFC 9110 §11.4
 * (formerly RFC 7235 §2.1):
 *
 * ```
 * credentials = auth-scheme [ 1*SP ( token68 / #auth-param ) ]
 * auth-scheme = token
 * ```
 *
 * Two consequences the naive `header.startsWith("Bearer ")` check gets
 * wrong, and that this helper honours:
 *
 * - the `auth-scheme` is a `token`, therefore **case-insensitive** — a
 *   client sending `authorization: bearer <token>` is conformant;
 * - the separator is `1*SP`, i.e. **one or more** SP (0x20) — not exactly
 *   one, and not HTAB (which the grammar excludes).
 *
 * The token itself is returned **verbatim**: never lowercased, never
 * trimmed. API keys and JWTs are case-sensitive, and a token that
 * (illegally) contains an inner space is handed back with that space
 * intact so the caller's own validation — not this parser — decides.
 *
 * Returns `null` for a missing header, a different scheme, a scheme with
 * no separator, or an empty token.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  // `i` folds only the literal `bearer`; the capture group reproduces the
  // input bytes unchanged. `s` lets the token span any byte a header could
  // legally carry, and `$` (no `m` flag) anchors at end-of-input. The
  // leading `[^ ]` stops a header that is nothing but scheme + spaces from
  // backtracking into a token made of the leftover spaces.
  const match = /^bearer +([^ ].*)$/is.exec(header);
  return match?.[1] ?? null;
}
