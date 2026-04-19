// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the `appstrate api` command. Kept in a leaf module
 * so every helper file can import `ApiCommandOptions` / `ApiCommandIO`
 * without reaching back into `commands/api.ts` (which would create a
 * cycle: api.ts → helpers/*.ts → api.ts).
 */

export interface ApiCommandOptions {
  profile?: string;
  /**
   * HTTP method. Optional — when omitted, inferred from flags:
   * `-I/--head` → HEAD, `-T/--upload-file` → PUT, body present → POST,
   * else GET. An explicit method (whether positional or via `-X`) wins.
   */
  method?: string;
  path: string;
  header: string[];
  form: string[];
  query: string[];
  data?: string;
  dataRaw?: string;
  dataBinary?: string;
  /**
   * `--data-urlencode <data>`: repeatable. Five curl parse forms are
   * supported:
   *   `content`         → URL-encoded value, no name
   *   `=content`        → URL-encoded value, no name (leading `=` stripped)
   *   `name=content`    → `name=<urlencoded content>`
   *   `@file`           → URL-encoded file contents, no name
   *   `name@file`       → `name=<urlencoded file contents>`
   * Combines with `-G` (values go to the query string) and acts as the
   * request body otherwise. Mutually exclusive with `-d / --data-raw /
   * --data-binary / -F / -T` (exit 2). Unlike curl we do NOT set a
   * default `Content-Type` — add `-H 'Content-Type: application/x-www-
   * form-urlencoded'` if the server expects it.
   */
  dataUrlencode?: string[];
  request?: string;
  output?: string;
  include?: boolean;
  head?: boolean;
  silent?: boolean;
  /**
   * `-S, --show-error`: when combined with `-s/--silent`, restores
   * error-message output on stderr while keeping progress / hints
   * suppressed. Matches curl's `-sS` pattern.
   */
  showError?: boolean;
  fail?: boolean;
  location?: boolean;
  insecure?: boolean;
  maxTime?: number;
  /**
   * `-v, --verbose`: trace request + response metadata on stderr
   * (one `>` line per request header, one `<` line per response
   * header, `*` for informational notes). Authorization is always
   * redacted. Verbose output bypasses `-s` (same as curl).
   */
  verbose?: boolean;
  /**
   * `-G, --get`: treat any `-d`/`--data-raw`/`--data-binary` values
   * as query parameters on a GET request (body is cleared). curl
   * semantics — each value is split on `=` and appended. Multipart
   * (`-F`) is incompatible and rejected with exit 2.
   */
  get?: boolean;
  /**
   * `-w, --write-out <fmt>`: after the body, write a curl-style format
   * string with `%{variable}` interpolation to stdout. Supported vars
   * documented on `formatWriteOut`. Unknown vars are passed through
   * verbatim (matches curl). Escape sequences `\n \r \t` are expanded
   * in the format string itself so shells that don't pre-interpolate
   * (zsh `echo` vs bash) produce the same output.
   */
  writeOut?: string;
  /**
   * `--connect-timeout <sec>`: abort if fetch() doesn't resolve its
   * response-headers Promise in N seconds. Approximates curl's
   * "time spent in DNS + TCP + TLS handshake" — Bun fetch doesn't
   * expose separate phases, but timing out before the server starts
   * streaming is the same user-visible behavior. Exit 28.
   */
  connectTimeout?: number;
  /**
   * `-T, --upload-file <path-or-->`: send the contents of a file as
   * the request body with default method PUT (curl semantics). `-T -`
   * streams stdin. Mutually exclusive with `-d / -F / --data-raw /
   * --data-binary` (exit 2).
   */
  uploadFile?: string;
  /**
   * `--retry <n>`: retry on transient HTTP codes (408, 429, 500, 502,
   * 503, 504) and DNS / timeout errors. Exponential backoff starting
   * at `retryDelay` seconds. ECONNREFUSED is terminal unless
   * `retryConnrefused` is set (curl semantics). Incompatible with
   * stdin body (`-d @-` / `-T -`) — we can't replay a consumed
   * stream; the CLI emits a warning and disables retry in that case.
   */
  retry?: number;
  /** `--retry-max-time <sec>`: total wall-clock budget for retries. */
  retryMaxTime?: number;
  /** `--retry-delay <sec>`: base backoff (defaults to 1s; doubled each attempt). */
  retryDelay?: number;
  /** `--retry-connrefused`: treat ECONNREFUSED as retryable too. */
  retryConnrefused?: boolean;
  /**
   * `--compressed`: advertise Accept-Encoding gzip/deflate/br. Bun's
   * fetch transparently decompresses the response body.
   */
  compressed?: boolean;
  /**
   * `-r, --range <spec>`: send a `Range: bytes=<spec>` header. Passes
   * through verbatim (e.g. `0-1023`, `-500`, `1000-`).
   */
  range?: string;
  /**
   * `-A, --user-agent <ua>`: override the default User-Agent. An
   * explicit `-H User-Agent: …` still wins (merge order).
   */
  userAgent?: string;
  /**
   * `-e, --referer <url>`: set the Referer request header. Shortcut
   * for `-H "Referer: <url>"`. curl's `;auto` variant is not supported.
   */
  referer?: string;
  /**
   * `-b, --cookie <data>`: literal cookie string `"k=v; k2=v2"`. File
   * paths (curl cookie jars) are NOT supported — the CLI rejects
   * anything that looks like a path with exit 2.
   */
  cookie?: string;
  /**
   * `--fail-with-body`: curl 7.76+ shape. When combined with a non-2xx,
   * exit 22/25 like `-f` but keep the response body going to stdout
   * (instead of suppressing it). Agents that need the error payload
   * for logging use this.
   */
  failWithBody?: boolean;
}

/**
 * Test seam. Production writes directly to `process.stdout.write` etc.;
 * unit tests inject in-memory sinks to assert on output ordering + byte
 * counts without spawning a subprocess.
 */
export interface ApiCommandIO {
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
  /** Hook so tests can assert exit codes without terminating the runner. */
  exit: (code: number) => never;
  /** Install SIGINT handler. Tests pass a no-op to skip. */
  onSigint?: (cb: () => void) => void;
  /** Optional stdin override. Defaults to `Bun.stdin.stream()`. */
  stdinStream?: () => ReadableStream<Uint8Array>;
}

export const DEFAULT_IO: ApiCommandIO = {
  stdout: {
    write(chunk) {
      if (typeof chunk === "string") process.stdout.write(chunk);
      else process.stdout.write(chunk);
    },
  },
  stderr: {
    write(chunk) {
      if (typeof chunk === "string") process.stderr.write(chunk);
      else process.stderr.write(chunk);
    },
  },
  exit: (code) => process.exit(code),
  onSigint: (cb) => {
    process.once("SIGINT", cb);
  },
  stdinStream: () => Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>,
};
