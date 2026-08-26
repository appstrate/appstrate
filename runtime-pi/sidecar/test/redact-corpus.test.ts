/**
 * Generated-corpus invariants for {@link scrubSecretMaterial}.
 *
 * WHY THIS FILE EXISTS. Every example-based test in `redact.test.ts` pins a
 * shape somebody thought of. Five consecutive attempts to widen or narrow this
 * scrubber each closed the case in front of them and opened a different one,
 * and each was found only by the next attempt:
 *
 *   - a keyword anchor widened so far it ate 38 prose strings;
 *   - a byte class narrowed so far it leaked DSN passwords built from
 *     RFC 3986 sub-delims;
 *   - percent-encoded exclusions applied to the RAW rule, leaking every
 *     password containing an encoded `&`, `/`, space or comma;
 *   - `=` dropped from the class, which is base64 padding, so EVERY
 *     `openssl rand -base64` password in a DSN shipped in clear.
 *
 * None of those was a shape anyone would have written a test for. What they
 * have in common is that they are found by GENERATING credentials rather than
 * enumerating them. That is what this file does, and it is the control that
 * was missing all five times.
 *
 * The two invariants below are deliberately blunt: a credential in a carrier
 * is masked, and prose is not. If a future change makes either false, this
 * file fails before the change can merge — no reviewer has to notice.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { scrubSecretMaterial } from "../redact.ts";

/** Password generators, one per alphabet that real tooling actually emits. */
const PASSWORDS: Record<string, () => string> = {
  // Contains `+` and `/` and is `=`-padded — the shape that leaked.
  base64: () => randomBytes(16).toString("base64"),
  base64_long: () => randomBytes(32).toString("base64"),
  base64url: () => randomBytes(24).toString("base64url"),
  hex: () => randomBytes(20).toString("hex"),
  // Every RFC 3986 sub-delim, which are all legal userinfo bytes.
  subdelims: () => `p!a$s'w(o)r*d+x${randomBytes(4).toString("hex")}`,
  percent_encoded: () => encodeURIComponent(randomBytes(12).toString("base64")),
};

/**
 * KNOWN UNCOVERED, stated rather than hidden: `https://svc:<pw>@host/path`
 * where `<pw>` contains a RAW `/`. That URL is malformed — the `/` starts the
 * path — and `https://` is exactly the scheme that appears in prose followed by
 * an unrelated `@`, so its rule must stop at `/` or it eats hosts out of log
 * lines. Measured: ~30% of `randomBytes(16).toString("base64")` passwords
 * contain a `/`. The correctly percent-encoded form IS masked, and every
 * credential-bearing scheme in `DSN_SCHEME` is masked even with a raw `/`.
 *
 * Carriers that put a password somewhere this scrubber is routed.
 */
const CARRIERS: Record<string, (pw: string) => string> = {
  dsn_postgres: (pw) => `postgres://svc_admin:${pw}@db.internal:5432/app`,
  dsn_mysql: (pw) => `mysql://root:${pw}@127.0.0.1:3306/appdb`,
  dsn_redis: (pw) => `redis://default:${pw}@cache.internal:6379/0`,
  dsn_amqp: (pw) => `amqps://user:${pw}@broker.internal/vhost`,
  in_error_prose: (pw) => `dial failed for postgres://svc:${pw}@db.internal/app (ECONNREFUSED)`,
  in_json: (pw) => `{"error":{"message":"connect postgres://svc:${pw}@db/app failed"}}`,
};

describe("scrubSecretMaterial — generated credential corpus", () => {
  it("masks every generated password in every credential carrier", () => {
    const leaks: string[] = [];
    let checked = 0;
    for (const [pwName, gen] of Object.entries(PASSWORDS)) {
      for (const [carrierName, wrap] of Object.entries(CARRIERS)) {
        for (let i = 0; i < 60; i++) {
          const pw = gen();
          if (pw.length < 8) continue; // too short to be a meaningful secret
          checked++;
          const out = scrubSecretMaterial(wrap(pw));
          if (out.includes(pw)) leaks.push(`${pwName}/${carrierName}: ${wrap(pw)}`);
        }
      }
    }
    // Positive control: the corpus must be large, or "0 leaks" is vacuous.
    expect(checked).toBeGreaterThan(2000);
    expect(
      leaks.slice(0, 5),
      `${leaks.length} of ${checked} generated credentials survived the scrubber.\n` +
        `Every entry below is a password that would reach a log or the\n` +
        `unauthenticated boot report in clear. First five:\n  ` +
        leaks.slice(0, 5).join("\n  "),
    ).toEqual([]);
  });

  it("control: leaves generated prose intact", () => {
    // The other half of the trade. A scrubber that masks everything passes the
    // test above and destroys every log line, so this bounds it from the other
    // side. These are the shapes the five attempts actually damaged.
    const prose = [
      "see https://docs.example.com,contact:admin@example.com",
      "reach us at postgres-support@example.com for help",
      "the postgres://localhost/db connection string carries no credentials",
      "connect-run: CONNECT_RESULT_KEY missing — refusing to emit bundle",
      "no token_endpoint and no issuer in the discovery document",
      "missing required field: api_key_id in manifest",
      "GET /integrations/boot-report 200 in 14ms",
    ];
    // KNOWN over-redaction, kept out of the list above and named here so it
    // cannot be forgotten: tier 2 treats bare whitespace as a separator, so
    // `<KEYWORD> <word>` loses the word. `"token budget exceeded"` ->
    // `"token [redacted] exceeded"`. It predates the tier split and is the
    // remaining half of the prose problem; closing it needs tier 2 to require
    // an assignment separator the way tier 1 does.
    const KNOWN_OVER_REDACTED = [
      "token budget exceeded: 128000 of 120000",
      "invalid password format (must contain a digit)",
      "Redeem AUTH_BOOTSTRAP_TOKEN to claim instance ownership",
    ];
    // Pinned so the day tier 2 is fixed, this list must shrink deliberately.
    expect(KNOWN_OVER_REDACTED.filter((p) => scrubSecretMaterial(p) !== p)).toHaveLength(3);

    const eaten = prose.filter((p) => scrubSecretMaterial(p) !== p);
    expect(
      eaten,
      `The scrubber redacted operator prose that carries no secret. Each of\n` +
        `these is a diagnostic somebody has to read:\n  ` +
        eaten.map((p) => `${p}\n    -> ${scrubSecretMaterial(p)}`).join("\n  "),
    ).toEqual([]);
  });
});
