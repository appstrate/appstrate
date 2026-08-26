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
  it("masks a value behind every separator that carries an assignment", () => {
    // The dimension this rule is ABOUT is the separator, so the corpus
    // enumerates separators instead of illustrating a few. A previous revision
    // narrowed the padding to `[ \t]` and was measured against eight separators,
    // none carrying a line break — it read as clean and leaked 43,200 generated
    // credentials on the shapes it had not enumerated. Two of the three sinks
    // scrub MULTI-LINE text, so `KEY:\n value` is the normal case, not an edge.
    const SEPARATORS = [
      "=",
      ":",
      ": ",
      " = ",
      "=\n",
      ":\n",
      ":\n ",
      ":\n  ",
      "\r\n=",
      '="',
      ':"',
      '": "',
      "%3D",
      "%3A",
      "=%20",
      ":%20",
      ": \t",
      "\t=\t",
      "=\r\n",
      "=\n\t",
    ];
    const leaks: string[] = [];
    for (const keyword of ["api_key", "notion_token", "AWS_SECRET_ACCESS_KEY", "client_secret"]) {
      for (const sep of SEPARATORS) {
        const value = `v${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
        const line = `spawn failed:\n${keyword}${sep}${value}\nat boot`;
        if (scrubSecretMaterial(line).includes(value))
          leaks.push(`${keyword} + ${JSON.stringify(sep)}`);
      }
    }
    expect(
      leaks,
      `A separator carrying an assignment character must reach the value, whatever\n` +
        `whitespace surrounds it. These did not:\n  ` +
        leaks.join("\n  "),
    ).toEqual([]);
  });

  it("control: whitespace alone still does not introduce a value", () => {
    // The other half, and the reason the rule is not simply "any separator":
    // bare whitespace between a keyword and a word is PROSE. This is the stated
    // cost — a `<keyword> <opaque value>` line with no assignment character is
    // not masked — and it is what keeps `token budget exceeded` readable.
    for (const prose of [
      "token budget exceeded: 128000 of 120000",
      "the access token has expired, refresh it",
      "Redeem AUTH_BOOTSTRAP_TOKEN to claim instance ownership",
    ]) {
      expect(scrubSecretMaterial(prose)).toBe(prose);
    }
  });

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

  // The other direction of the tier-2 separator narrowing. Dropping bare
  // whitespace reclaimed 1,545 prose strings; this generates the shapes that
  // narrowing must NOT have cost — every keyword the rule knows, at every case,
  // behind every assignment character the sinks actually produce (env-file
  // lines, JSON bodies, header strings, percent-encoded query values).
  it("masks a generated value behind every assignment separator", () => {
    // Names whose LAST segment is a tier-2 keyword: covered in BOTH cases —
    // tier 1 takes the SCREAMING_SNAKE form, tier 2 the lowercase twin.
    const BOTH_CASES = [
      "TOKEN",
      "SECRET",
      "PASSWORD",
      "API_KEY",
      "AUTHORIZATION",
      "ACCESS_TOKEN",
      "REFRESH_TOKEN",
      "NOTION_TOKEN",
      "GCP_SECRET",
      "STRIPE_API_KEY",
      "CLIENT_SECRET",
    ];
    // Names carrying a segment PAST the keyword, or built on bare `KEY`: tier 1
    // only, so UPPERCASE only. This is the cost the tier-1 docstring states —
    // `aws_secret_access_key=…` is not covered — asserted here rather than
    // taken on trust, and it predates the separator change on both sides.
    const UPPER_ONLY = ["AWS_SECRET_ACCESS_KEY", "CLIENT_SECRET_ID", "PRIVATE_KEY", "KEY_FILE"];
    const ASSIGN: Array<(n: string, v: string) => string> = [
      (n, v) => `${n}=${v}`,
      (n, v) => `${n} = ${v}`,
      (n, v) => `${n}='${v}'`,
      (n, v) => `{"${n}": "${v}"}`,
      (n, v) => `${n}: ${v}`,
      (n, v) => `env-file line 1: ${n}=${v}`,
      (n, v) => `docker: invalid variable '${n}=${v}'`,
      (n, v) => `q?${n}%3D${v}&next=1`,
    ];
    const cases: string[] = [...BOTH_CASES.flatMap((n) => [n, n.toLowerCase()]), ...UPPER_ONLY];
    const leaks: string[] = [];
    let checked = 0;
    for (const name of cases) {
      for (const wrap of ASSIGN) {
        for (let i = 0; i < 4; i++) {
          // Alphanumeric so the value cannot be masked by a shape rule
          // instead — this must be the keyword rule doing the work.
          const value =
            randomBytes(18)
              .toString("base64")
              .replace(/[^A-Za-z0-9]/g, "") + "7";
          checked++;
          const line = wrap(name, value);
          if (scrubSecretMaterial(line).includes(value)) leaks.push(line);
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
    expect(
      leaks.slice(0, 5),
      `${leaks.length} of ${checked} assignment-separated credentials survived.\n` +
        `Narrowing the keyword separator must not cost the shapes that DO\n` +
        `carry an assignment. First five:\n  ` +
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
    // This list WAS `KNOWN_OVER_REDACTED`, pinned at 3 while tier 2 still took
    // bare whitespace as a separator, so `<KEYWORD> <word>` lost the word. Tier
    // 2 now requires the same assignment separator as tier 1, so the count of
    // survivors is 0 — and the list stays here, populated, rather than being
    // emptied to satisfy the assertion. An empty array would make the filter
    // below pass while checking nothing; these seven strings are the positive
    // control that it still checks something.
    //
    // The last four are the `_`-anchored half of the same defect: tier 2 admits
    // `_` on the LEFT of the keyword (it must, or `notion_token=…` ships in
    // clear), which combined with whitespace made an env-var NAME mentioned in
    // a sentence eat the next word.
    const PREVIOUSLY_OVER_REDACTED = [
      "token budget exceeded: 128000 of 120000",
      "invalid password format (must contain a digit)",
      "Redeem AUTH_BOOTSTRAP_TOKEN to claim instance ownership",
      "RUN_TOKEN_SECRET produced an empty keyring",
      "treats empty MODEL_API_KEY as unset",
      "an empty client_secret clears the stored credential",
      "the access token has expired, refresh it",
    ];
    expect(PREVIOUSLY_OVER_REDACTED.filter((p) => scrubSecretMaterial(p) !== p)).toHaveLength(0);

    const eaten = [...prose, ...PREVIOUSLY_OVER_REDACTED].filter(
      (p) => scrubSecretMaterial(p) !== p,
    );
    expect(
      eaten,
      `The scrubber redacted operator prose that carries no secret. Each of\n` +
        `these is a diagnostic somebody has to read:\n  ` +
        eaten.map((p) => `${p}\n    -> ${scrubSecretMaterial(p)}`).join("\n  "),
    ).toEqual([]);
  });
});
