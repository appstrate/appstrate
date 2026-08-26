// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-log header redaction for the OAuth LLM proxy path.
 *
 * Upstream LLM providers can echo credential-bearing material on
 * auth-failure responses (`WWW-Authenticate` challenge, `Set-Cookie`
 * session token). The sidecar's warn log is collected by the operator's
 * log aggregator (pino JSON → stdout), so any verbatim copy is a leak.
 *
 * We drop the well-known credential-carrying headers entirely rather
 * than try to parse their values. Body samples are truncated to a small
 * preview (set at the call-site) — JSON error payloads from major LLM
 * providers don't echo bearer tokens back, so per-shape regex scrubbing
 * is unnecessary.
 *
 * `Location` is special-cased: dropping it entirely would blind the
 * operator on redirect-loop diagnosis, but logging it verbatim leaks a
 * presigned/`?access_token=` redirect target into the debug envelope.
 * It is redacted to origin + path (query string, fragment, and userinfo
 * stripped) — same philosophy as `redactHost` in the api-call engine.
 */

/**
 * Headers stripped from operator logs. Lowercased for case-insensitive
 * comparison; HTTP header names are case-insensitive per RFC 7230.
 *
 * Rationale per entry:
 *   - `set-cookie`            session cookies set by the upstream
 *   - `www-authenticate`      can carry a fresh bearer challenge
 *   - `proxy-authenticate`    same as above for proxy hops
 *   - `authorization`         echoed back on some 401 paths
 *   - `x-api-key`             ditto for api-key auth schemes
 *   - `cookie`                inbound cookies if the upstream mirrors them
 */
const SENSITIVE_HEADER_NAMES = new Set<string>([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "authorization",
  "x-api-key",
  "cookie",
]);

/**
 * Redact a `Location` header value to origin + path.
 *
 * Redirect targets routinely carry capabilities in the query string
 * (S3 presigned `X-Amz-Signature`, OAuth `?access_token=`/`?code=`) and
 * occasionally userinfo in the authority — none of which may reach the
 * operator log. The origin + path is kept because it is the part an
 * operator needs to diagnose a redirect loop.
 *
 * Handles the three RFC 7231 §7.1.2 reference forms:
 *   - absolute (`https://host/p?q`) → `https://host/p` (userinfo is not
 *     part of `URL.origin`, so it is stripped for free),
 *   - scheme-relative (`//host/p?q`) → `//host/p` (parsed against a dummy
 *     base so userinfo is stripped rather than string-sliced),
 *   - relative (`/p?q`, `p?q`) → kept as-is minus query/fragment.
 */
export function redactLocationHeader(value: string): string {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Not an absolute URL — fall through to the relative forms.
  }
  if (value.startsWith("//")) {
    try {
      const u = new URL(value, "https://placeholder.invalid");
      return `//${u.host}${u.pathname}`;
    } catch {
      return "<unparseable>";
    }
  }
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Drop a sensitive header (`null`), redact `Location`, or pass through. */
function redactHeaderValue(key: string, value: string): string | null {
  const lower = key.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return null;
  if (lower === "location") return redactLocationHeader(value);
  return value;
}

/**
 * Drop sensitive headers (and redact `Location` to origin + path) and
 * return a plain object suitable for JSON serialization in the operator
 * log. Original casing is preserved on the surviving entries.
 */
export function filterSensitiveHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      const kept = redactHeaderValue(key, value);
      if (kept !== null) out[key] = kept;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const kept = redactHeaderValue(key, value);
    if (kept !== null) out[key] = kept;
  }
  return out;
}

/**
 * Scrub credential material from a free-form text sample before it lands in an
 * operator log or a run failure report. Upstream payloads don't normally echo
 * credentials, but the no-leak guarantee must hold independent of upstream
 * behavior.
 *
 * THE single scrubber for the sidecar. There were two: this one covered only
 * `sk-ant-…` and `Bearer …`, while `integrations-boot.scrubStderrLine` covered
 * a strict superset — and the two lived in the same process with no trust
 * boundary between them, so the weaker one simply leaked more. A `ghp_…`, a
 * JWT or an `AKIA…` in an upstream error body survived into the operator log
 * on the `/llm` path and was masked on the runner-stderr path. The superset
 * won; callers that also need a length cap apply it themselves.
 *
 * Separator-prefixed families (`sk-…`, `ghp_…`, `xoxb-…`) keep the mandatory
 * `-`/`_` so prose words starting with `sk`/`pk` survive; AWS access-key ids
 * (`AKIA` + upper-alnum, no separator) and Google OAuth tokens (`ya29.` + dot)
 * get their own literal shapes. `sk-ant-` is matched case-insensitively ahead
 * of the generic family rule because Anthropic keys appear upper-cased in some
 * upstream error text, and the generic rule is deliberately case-sensitive.
 */

/**
 * Start-of-credential anchor, replacing a bare `\b`.
 *
 * This exists because `\b` was wrong here THREE times, each caught only after
 * the previous "fix" shipped, so the rule is now stated once instead of spelled
 * out per pattern. Percent-encoded text is the whole problem: every triplet
 * ends in an alphanumeric (`%20`→`0`, `%3D`→`D`, `%26`→`6`), and every shape
 * below starts with one, so `\b` — which needs a non-word character on the
 * left — can never match a credential that follows an encoded separator. That
 * is not an exotic input: it is what a redirect target or an echoed
 * `redirect_uri` looks like in an upstream error body, i.e. the exact material
 * this function exists to scrub.
 *
 * `(?<=^|[^A-Za-z0-9_])` is EXACTLY equivalent to `\b` for these patterns
 * (they all begin with a word character, so `\b` reduces to "start, or a
 * non-word char on the left"). The `%[0-9A-Fa-f]{2}` alternative is the only
 * widening: it additionally admits a preceding percent-triplet. So the prose
 * protection `\b` bought is preserved intact — "risk-averse" still does not
 * match the `sk-…` family, "skeletons" and "pkgroots" stay readable — while
 * the encoded case is no longer a hole.
 */
const CRED_START = String.raw`(?<=^|%[0-9A-Fa-f]{2}|[^A-Za-z0-9_])`;

/**
 * Start-of-KEYWORD anchor. Identical to {@link CRED_START} except that `_` is
 * admitted on the left.
 *
 * That single character was the fourth bug on this anchor, from the side the
 * first three did not cover. `CRED_START` treats `_` as a word character, so
 * `NOTION_TOKEN=…`, `GCP_SECRET=…` and `STRIPE_API_KEY=…` never matched — and
 * `FOO_TOKEN=value` is the dominant shape on the paths this scrubber is
 * routed through: docker's `--env-file` parser quotes the offending
 * `NAME=value` line back in its diagnostics, and runner stderr prints env
 * names. Both end up in `failed[].error` on the UNAUTHENTICATED
 * `GET /integrations/boot-report` the agent container reads.
 *
 * It stays as strict as `\b` on every OTHER left-hand character, which is what
 * keeps `mytoken=abc` and `9secret=z` readable prose: a keyword glued to a
 * letter or a digit is still part of a longer word, a keyword glued to `_` is
 * an env-var name whose value is a credential. Only the keyword rule uses
 * this — the credential-SHAPE rules (`sk-…`, `ghp_…`, `eyJ…`, `AKIA…`,
 * `ya29.`) keep `CRED_START`, where `_` on the left genuinely means "middle of
 * an identifier".
 */
const KEYWORD_START = String.raw`(?<=^|%[0-9A-Fa-f]{2}|[^A-Za-z0-9])`;

/**
 * The NAME half of the keyword rule, split into TWO tiers that differ in the
 * NAME each accepts — and in nothing else. Both take the same value class and
 * the same {@link ASSIGNMENT_SEP}; the split exists because one tier is
 * case-SENSITIVE with `_`-joined segments and the other is case-INsensitive
 * with none, which is two regex flags and cannot be one pattern.
 *
 * Collapsing them into one rule is what made this rule eat prose: the single
 * pre-split rule was case-insensitive AND whitespace-separated at once, and
 * each half destroyed a different population of operator diagnostics.
 *
 * TIER 1 — env-var NAME ({@link ENV_NAME_KEYWORD} + {@link ASSIGNMENT_SEP}).
 * Fifth bug on the same rule, and the one that mattered most on the sink it
 * was routed to. {@link KEYWORD_START} admitting `_` on the LEFT only bought
 * the names whose LAST segment is the keyword (`NOTION_TOKEN`); the separator
 * group AFTER the keyword never admitted `_`, so every name carrying a segment
 * past the keyword shipped its value verbatim — `AWS_SECRET_ACCESS_KEY`, the
 * most canonical `delivery.env` name there is, and `CLIENT_SECRET_ID` among
 * them. The trailing `(?:_SEGMENT){0,8}` closes that side. There are no
 * LEADING segments: {@link KEYWORD_START} already admits `_`, so the match
 * simply starts at the keyword and `AWS_` stays outside it, byte-identically.
 *
 * This tier is UPPERCASE-ONLY and requires an ASSIGNMENT separator, and those
 * two constraints are what stop the widening from costing legibility. Both
 * were absent when it shipped, and between them they redacted the next word of
 * 38 prose strings in `apps/api/src`, `runtime-pi/` and `packages/core/src`,
 * none of them a secret:
 *
 *   - Whitespace as a separator turned `<NAME> <word>` into `<NAME> [redacted]`
 *     — including this sidecar's own user-visible errors, e.g. `connect-run:
 *     CONNECT_RESULT_KEY missing — refusing to emit bundle`, whose one word
 *     carrying the diagnosis was the one destroyed. Every real leak shape uses
 *     an assignment character anyway (`AWS_SECRET_ACCESS_KEY=v`,
 *     `"token": "v"`, `Authorization: Bearer x`), so requiring one costs no
 *     coverage. Whitespace is still allowed AROUND the assignment, never
 *     INSTEAD of it.
 *   - Case-insensitivity made the tier fire on lower_snake FIELD names that
 *     share the shape but are not credentials — `token_endpoint_auth_method`,
 *     `refresh_token_issuance`, `authorization_code`, `auth_key` — and those
 *     do carry an assignment (`token_endpoint_auth_method='none'`), so the
 *     separator fix alone does not reach them. Env-var names are
 *     SCREAMING_SNAKE on every path that feeds this scrubber: docker's
 *     `--env-file` diagnostics quote the offending `NAME=value` line back, and
 *     runner stderr prints env names.
 *
 * The cost of the case constraint is stated rather than hidden: a LOWERCASE
 * env name with a segment AFTER the keyword (`aws_secret_access_key=…`) is not
 * covered by this tier. Tier 2 still covers the lowercase names that END in a
 * keyword (`notion_token=…`), which is the shape a lowercase env file takes.
 *
 * Bare `KEY` is the one keyword that is prose on its own ("no api key
 * provided"), so it counts only when glued into an underscore-joined name —
 * expressed as an explicit `_` on its left (`GCP_KEY`, `PRIVATE_KEY`) or a
 * segment on its right (`KEY_FILE`), which no sentence produces.
 *
 * TIER 2 — bare keyword ({@link BARE_KEYWORD} + {@link ASSIGNMENT_SEP}).
 * Case-insensitive and segment-less, which is what covers the shapes tier 1's
 * two constraints give up: a lowercase env name whose last segment is the
 * keyword (`notion_token=…`) and the JSON field an error body carries
 * (`{"access_token": "…"}`). It requires the SAME assignment separator as
 * tier 1 — the two tiers differ in the NAME half only, never in what may sit
 * between a name and its value.
 *
 * That is the sixth bug on this rule, and the first five fixes each stopped one
 * tier short of it. Tier 2 accepted bare WHITESPACE, so `<keyword> <word>` lost
 * the word: measured over the 68,449 string literals and comment lines in
 * `apps/api/src`, `runtime-pi/` and `packages/core/src`, requiring an
 * assignment here hands back 1,545 of them and re-redacts none. Four of the six
 * worked examples were pure tier-2 whitespace damage — `token budget exceeded`,
 * `invalid password format (must contain a digit)`, `RUN_TOKEN_SECRET produced
 * an empty keyring`, `an empty client_secret clears the stored credential`.
 *
 * The justification this docstring used to carry for keeping whitespace — that
 * CLI and runner diagnostics echo `--password <secret>` with no assignment
 * character — does not survive contact with the paths the scrubber is actually
 * routed through, and was never true of them:
 *
 *   - A credential reaches a spawned integration through `delivery.env`,
 *     `delivery.http` (header) or `delivery.files`, and through nothing else —
 *     `packages/core/src/integration.ts` enumerates the three. Argv is not a
 *     delivery channel, so no platform-produced diagnostic can echo one.
 *   - `--token <secret>` does occur in `apps/cli`, and that CLI is a different
 *     process that never calls this function. Even there the one place a token
 *     could land on a command line refuses to put it there
 *     (`apps/cli/src/commands/install.ts`: "NOT argv: a `--token <secret>` on
 *     the sudo command line is visible to any process").
 *   - Outside those two, the shape appears nowhere in `apps/api/src`,
 *     `runtime-pi/` or `packages/core/src` except in this docstring's own
 *     previous claim.
 *
 * The cost is stated rather than hidden: a bare `token <value>` with no
 * assignment character anywhere — a third-party MCP server printing its own
 * credential in a shape the platform never produces — is no longer masked by
 * the keyword rule. The shape rules (`Bearer …`, `sk-…`, `ghp_…`, `eyJ…`,
 * `AKIA…`, `ya29.`) and the two userinfo rules still cover it whenever the
 * value is recognisable, and this rule was always the defence-in-depth half of
 * the guarantee (see `integrations-boot.scrubStderrLine`) — the primary control
 * is that runs are org-scoped to an actor who already holds the credential.
 *
 * `mytoken=`, `9secret=` and `monkey_bars=` stay prose in both tiers: the first
 * two fail {@link KEYWORD_START} at the keyword, the third has an `_` but no
 * keyword on a segment boundary.
 *
 * The segment quantifiers are bounded, and that is load-bearing rather than
 * cosmetic. An UNBOUNDED `(?:_[A-Z0-9]+)*` costs O(n) of backtracking at every
 * start offset that has no keyword, i.e. O(n²) over the text — and callers
 * scrub upstream-controlled input. `{0,8}` segments of `{1,64}` bytes covers
 * every real env-var name (`AWS_SECRET_ACCESS_KEY` is 4).
 */
const SEGMENT_BODY = String.raw`[A-Z0-9]{1,64}`;
const ENV_NAME_KEYWORD =
  String.raw`(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTHORIZATION|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)` +
  String.raw`(?:_${SEGMENT_BODY}){0,8}` +
  String.raw`|(?<=_)KEY(?:_${SEGMENT_BODY}){0,8}` +
  String.raw`|KEY(?:_${SEGMENT_BODY}){1,8}`;
const BARE_KEYWORD = String.raw`token|secret|password|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token`;

/**
 * An assignment character, raw or percent-encoded: `=`, `:`, or a quote. These
 * are what actually separates a credential name from its value on every path
 * that reaches this scrubber — env-file lines, JSON bodies, header strings.
 */
const ASSIGN_CHAR = String.raw`(?:["'=:]|%22|%27|%3D|%3A)`;
/**
 * The separator, in BOTH tiers: whitespace may surround an assignment, never
 * replace it. `NAME = value` and `"name": "value"` both pass; `NAME word` does
 * not. See {@link BARE_KEYWORD} for why tier 2 no longer has one of its own.
 */
const ASSIGNMENT_SEP = String.raw`(?:[ \t]|%20)*${ASSIGN_CHAR}(?:${ASSIGN_CHAR}|[ \t]|%20)*`;
/** The value a separator introduces, up to the next item boundary. */
const KEYWORD_VALUE = String.raw`[^\s"',&]+`;

/**
 * Percent triplets that END an ENCODED userinfo rather than belong to it.
 *
 * This is the ENCODED rendering's exclusion list and ONLY that. Sharing it with
 * the raw rule was a leak, because it inverts what percent-encoding means: a
 * triplet inside a RAW authority is, by definition, a byte the userinfo had to
 * encode — `&`, `/`, space and `,` are legal in a URL in no other form — so
 * refusing triplets there refuses real passwords. Four shapes shipped verbatim
 * for as long as the raw rule carried this list, all of them ordinary
 * generated-DSN passwords (base64 alphabets contain `/`):
 * `postgres://user:pa%26ss@db`, `pa%2Fss`, `pa%20ss`, `pa%2Css`.
 *
 * What the two renderings must share is a VERDICT — the same authority is
 * masked in both, or left whole in both — and that is not the same thing as
 * sharing one byte class. Each rendering spells its own separators: between two
 * RAW URLs the separator is itself raw (`,` `&` `;` `=` whitespace `"`), which
 * {@link USERINFO_BYTE} already refuses; between two ENCODED URLs it is a
 * triplet, which decomposes into bytes (`%`, `2`, `C`) that the byte class
 * admits one at a time. So the encoded rule — and only it — needs this list on
 * top, or it reproduces the spanning defect its raw twin was fixed for:
 * `see https%3A%2F%2Fdocs.example.com%2Ccontact%3Aadmin%40example.com` came out
 * as `see https%3A%2F%2F[redacted]%40example.com`.
 *
 * Entries: `%2C`/`%26`/`%3B`/`%3D`/`%20`/`%22`/`%09`/`%0A`/`%0D` are the encoded
 * twins of the separators {@link USERINFO_BYTE} refuses — one triplet per
 * refused raw byte, which is what keeps the two verdicts aligned;
 * `%2F`/`%3F`/`%23` are the encoded authority terminators.
 *
 * `%40` is deliberately absent: it is the encoded `@` the encoded rule matches
 * ON, and its lazy quantifier already stops at the first one.
 */
const USERINFO_STOP_TRIPLET = String.raw`%(?:2C|26|20|22|2F|3F|23|09|0A|0D)`;

/**
 * Bytes a URL authority may carry before the `@` that ends its userinfo, in the
 * RAW rendering. The encoded rendering layers {@link USERINFO_STOP_TRIPLET} on
 * top of this class; it does not get a different class.
 *
 * Deliberately a POSITIVE class rather than the negated `[^/?#@\s]` it
 * replaced. That negation stopped only at `/`, `?`, `#` and whitespace, so a
 * comma between two unrelated URLs let one match run from the first
 * authority all the way to an `@` in the second:
 * `see https://docs.example.com,contact:admin@example.com` came out as
 * `see https://[redacted]@example.com` — the host the operator diagnoses with,
 * gone, and nothing sensitive masked in exchange.
 *
 * What it admits is RFC 3986 §3.2.1 userinfo: unreserved (`A-Za-z0-9._~-`),
 * `:`, percent-triplets, and the sub-delims `!$&'()*+,;=` minus the four that
 * separate one item from the next in the prose and query strings this scrubber
 * runs over. "Sub-delims are back" is NOT the rule — both directions of that
 * generalisation have now shipped a defect — so the verdict is stated per
 * character:
 *
 *   - `!` `$` `'` `(` `)` `*` `+` — ADMITTED. None of them separates two items
 *     in prose, a query string or a header value; each is a byte real DSN
 *     passwords carry (`s3cr3t!x`, `pa$$w0rd`, `p(ass)`, `x'y`), and dropping
 *     them in the narrowing that fixed the comma shipped those passwords whole.
 *   - `&` — REFUSED. The query-parameter separator.
 *   - `,` — REFUSED. The list separator in prose and in HTTP header values;
 *     the original spanning case.
 *   - `;` — REFUSED. Separates parameters in cookies, matrix params and query
 *     strings. Admitting it reopened the comma defect verbatim:
 *     `see https://docs.example.com;contact:admin@example.com` came out as
 *     `see https://[redacted]@example.com`.
 *   - `=` — REFUSED. The key/value separator, so a match crossed out of a
 *     redirect target into the next parameter:
 *     `GET /v1?next=https://cb.example.com;user=a@b.com` lost `cb.example.com`.
 *
 * The price of refusing `;` and `=` is stated rather than hidden: a RAW `;` or
 * `=` inside a password (`postgres://user:pa=ss@db`) is not masked. It is not a
 * regression — neither byte was in this class before the pass that reopened
 * spanning — and the ENCODED rendering of the same password (`pa%3Dss`,
 * `pa%3Bss`) IS masked by the raw rule, which is the rendering a DSN takes
 * wherever it travels through a URL or a query parameter.
 */
/**
 * URI schemes whose authority always carries credentials and is always followed
 * by a database or vhost path. A raw `/` inside their userinfo makes the URI
 * malformed rather than ambiguous, and none of them appears in prose followed
 * by an unrelated `@` — so this rule may span a `/`, which the generic userinfo
 * rule below deliberately must not.
 *
 * Measured, and the reason this exists: `openssl rand -base64 16` emits `/`
 * about a quarter of the time, and 100% of the DSN passwords the generic rule
 * still leaked contained one. With this rule, 0 of 1000 generated base64
 * passwords survive; without it, 269. Re-measure by generating
 * `randomBytes(16).toString("base64")` into `postgres://svc:<pw>@h/db`.
 */
const DSN_SCHEME =
  "(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqps?|clickhouse|mssql)";

const USERINFO_BYTE = String.raw`[A-Za-z0-9._~:%+!$'()*;=-]`;

/**
 * {@link USERINFO_BYTE} as the ENCODED rendering needs it: the same class, plus
 * the triplet exclusions that rendering's separators require.
 */
const USERINFO_BYTE_ENCODED = String.raw`(?:(?!${USERINFO_STOP_TRIPLET})${USERINFO_BYTE})`;

/**
 * Ordered scrub rules. Compiled once: these run on every proxied error body.
 *
 * `Bearer|Basic` and `sk-ant-` deliberately carry NO anchor — those literals
 * are specific enough not to need one. Their separator group accepts `%20`
 * alongside real whitespace for the same reason `CRED_START` exists, and the
 * token class admits `%` so a percent-encoded base64 credential is masked
 * whole rather than up to its first `%2B`.
 *
 * Every alternative in every separator group starts with a distinct character
 * (`%` appears in none of the literal classes), so the groups stay unambiguous
 * and the whole set runs in linear time.
 */
const SCRUB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Credential-bearing DSN. First, because it may span a `/` that the
  // generic userinfo rules below stop at. See {@link DSN_SCHEME}.
  [new RegExp("(" + DSN_SCHEME + "://)[^\\s@]*@", "gi"), "$1[redacted]@"],
  // URL userinfo (`scheme://user:pass@host/…`). A credential channel no
  // keyword or prefix rule sees: `pass` is arbitrary, and the whole `user:pass`
  // is masked rather than just the half after the colon, because a bare-token
  // userinfo (`https://<token>@host`) carries the secret in the FIRST half.
  // Runs first so a URL whose userinfo happens to contain a keyword
  // (`https://token:hunter2@host/path`) is masked as userinfo rather than
  // swallowing the host and path into the keyword rule's value class.
  // {@link USERINFO_BYTE} admits neither `/`, `?`, `#`, whitespace, a quote,
  // an ampersand, a comma, a semicolon nor an equals, so an `@` inside a path
  // or query (`/users/me@example.com`) is not userinfo, and a match can never
  // span from one URL to the next. Percent-triplets ARE admitted here: inside a
  // raw authority a triplet is a byte the password had to encode.
  [new RegExp(`(:\\/\\/)${USERINFO_BYTE}*@`, "gi"), "$1[redacted]@"],
  // Percent-encoded form (`https%3A%2F%2Fuser%3Apass%40host%2Fcb`). Encoded
  // URLs are the whole reason this file has an anchor of its own, and a
  // `redirect_uri=` value — where an OAuth error body echoes a userinfo back —
  // is encoded by definition. This rendering — and only this one — layers
  // {@link USERINFO_STOP_TRIPLET} on the byte class, so it refuses `%2F`/`%3F`/
  // `%23` (the path) and `%2C`/`%26`/`%3B`/`%3D`/`%20`/`%22` (the next item
  // along); the lazy quantifier stops at the FIRST `%40` of the authority.
  [new RegExp(`(%3A%2F%2F)${USERINFO_BYTE_ENCODED}*?%40`, "gi"), "$1[redacted]%40"],
  [/(Bearer|Basic)(?:\s|%20)+[A-Za-z0-9._~+/=%-]+/gi, "$1 [redacted]"],
  [new RegExp(`${CRED_START}eyJ[A-Za-z0-9._-]{10,}`, "g"), "[redacted-jwt]"],
  [/sk-ant-[A-Za-z0-9._-]+/gi, "[redacted-key]"],
  [
    new RegExp(`${CRED_START}(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9._-]{6,}`, "g"),
    "[redacted-key]",
  ],
  [new RegExp(`${CRED_START}AKIA[A-Z0-9]{12,}`, "g"), "[redacted-key]"],
  [new RegExp(`${CRED_START}ya29\\.[A-Za-z0-9._-]{6,}`, "g"), "[redacted-key]"],
  // Tier 1 — env-var name. Case-SENSITIVE ("g", not "gi") and assignment-only;
  // see {@link ENV_NAME_KEYWORD} for why each of those two is load-bearing.
  [
    new RegExp(`${KEYWORD_START}(${ENV_NAME_KEYWORD})(${ASSIGNMENT_SEP})${KEYWORD_VALUE}`, "g"),
    "$1$2[redacted]",
  ],
  // Tier 2 — bare keyword, case-insensitive, and assignment-only exactly like
  // tier 1; see {@link BARE_KEYWORD} for why whitespace is not a separator.
  [
    new RegExp(`${KEYWORD_START}(${BARE_KEYWORD})(${ASSIGNMENT_SEP})${KEYWORD_VALUE}`, "gi"),
    "$1$2[redacted]",
  ],
];

export function scrubSecretMaterial(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB_RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * A run of authority-legal bytes left hanging at the end of a cut text — i.e.
 * an authority whose terminator the CUT may have removed, one per rendering.
 */
const TRUNCATED_AUTHORITY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`(:\\/\\/)${USERINFO_BYTE}+$`), "$1[redacted]"],
  [new RegExp(`(%3A%2F%2F)${USERINFO_BYTE_ENCODED}+$`, "i"), "$1[redacted]"],
];

/**
 * Slice `text` to `maxChars` for a caller that scrubs afterwards, masking an
 * authority the slice itself left unterminated.
 *
 * Callers MUST slice before scrubbing, and this exists because that ordering
 * has a blind spot they cannot see. `scrubSecretMaterial` is a pass of ~10
 * global regexes over upstream-controlled text on a single-threaded sidecar:
 * scrubbing a 1 MB error body to produce a 200-char log line blocked the event
 * loop for 2.5 s (measured, adversarial body) where slice-first costs ~0.05 ms.
 * So the bound stays, and this function is bounded by it — one anchored match
 * over the ALREADY-sliced text, O(cut), never O(body).
 *
 * The blind spot: every other rule in `redact.ts` matches a credential from its
 * START, so a cut can only shorten what a rule already matched. The two
 * userinfo rules are the exception — they need the `@`/`%40` that ENDS the
 * userinfo before they can match at all. Cut that terminator off and the rule
 * does not fire at all, and the visible prefix ships raw:
 *
 *   `{"error":{"message":"dial failed for postgres://svc_admin:S3cr3tP4ssw…`
 *
 * which put ~130 characters of a DSN password into the operator log. Raising
 * the caller's margin does not close that — it only moves the cut, and the next
 * authority to straddle it leaks the same way. So the terminator is treated as
 * UNKNOWN rather than assumed absent: a run of authority-legal bytes that
 * reaches the end of the cut may or may not have been followed by an `@`, and
 * the only safe reading of "may" is to mask it.
 *
 * The mask fires ONLY when the text was actually cut. On a complete text the
 * scrubber sees every terminator there is, so a trailing `://run` with no `@`
 * genuinely has no userinfo, and masking it would destroy a host for nothing.
 * When it does fire it costs the tail of one truncated URL — the scheme and the
 * fact that a URL was cut both survive — which is the trade this file makes
 * everywhere else: never a leak, occasionally a lost host at the very cut.
 */
export function truncateForScrub(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let out = text.slice(0, maxChars);
  for (const [pattern, replacement] of TRUNCATED_AUTHORITY_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
