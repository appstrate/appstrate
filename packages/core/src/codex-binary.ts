// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Resolve the prebuilt `codex` native binary that backs the OpenAI Codex CLI,
 * plus the `auth.json` + curated env a host needs to drive it headlessly.
 *
 * The Codex counterpart of {@link ./claude-binary.ts}. Codex is a single Rust
 * binary (not an npm SDK with a `query()` function), so hosts drive it as a
 * subprocess: `codex exec --json …`. The CLI's models-manager calls
 * `chatgpt.com` VERBATIM and ignores any `chatgpt_base_url` override, so — unlike
 * the Claude path — the sidecar cannot reverse-proxy it. Instead the real
 * subscription token is written into `auth.json` and the binary egresses
 * straight to the upstream. This module holds the universal parts:
 *   - the per-arch package matrix (so `bun install` of `@openai/codex` places
 *     the matching binary; we resolve whichever variant is present),
 *   - the `auth.json` builder (ChatGPT-subscription mode) + the thin
 *     `writeCodexAuthHome` IO wrapper that materialises it into an ephemeral
 *     `CODEX_HOME`, and
 *   - the curated subprocess env.
 *
 * ToS posture (identical to claude): the official `codex` binary signs its OWN
 * client fingerprint (`originator: codex_exec`) and sends its own
 * `chatgpt-account-id`. We forge NOTHING. Because the token cannot be swapped in
 * flight, the binary holds the genuine subscription token (vended at run start);
 * the compensating control is the sidecar's per-run egress allowlist, which
 * locks outbound traffic to the provider's hosts so the token cannot be
 * exfiltrated (see `LlmProxyVendConfig` in `./sidecar-types.ts`).
 *
 * The linux per-arch binaries are **musl-static**
 * (`*-unknown-linux-musl`), so they run on the Alpine production image with no
 * glibc shim — unlike many Rust CLIs. This module imports nothing from
 * `@openai/codex`; it resolves package-specifier *strings* through an injected
 * resolver, so `@appstrate/core` gains no dependency on the Codex CLI.
 */

import { createRequire } from "node:module";
import { mkdtemp, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX_SCOPE = "@openai/codex";

/** Fallback UUID written into `auth.json` only when the credential carries no
 * account id. When present, the credential's REAL `chatgpt_account_id` is written
 * verbatim (the CLI sends it as the `chatgpt-account-id` header). This dummy just
 * keeps the CLI booting in ChatGPT mode for credentials that lack the claim. */
const PLACEHOLDER_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/** Base64url without padding (Bun/Node `base64url` encoding). */
function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Best-effort scrub of credential material from a `codex` subprocess's stderr
 * before it is logged or folded into a run error. The spawned binary holds the
 * real subscription token in its `auth.json`; its stderr is therefore treated as
 * potentially secret-bearing (defense-in-depth — the CLI is not expected to echo
 * the bearer, but we never persist its stderr unredacted). Strips `Bearer`
 * tokens, JWTs, and `sk-`-style keys by SHAPE, plus any caller-supplied known
 * secret values by VALUE (so a future non-JWT token shape echoed bare is still
 * caught — pass the vended `access_token`).
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  // Value-based redaction first: exact known secrets, longest-first so a token
  // that contains a shorter one is fully masked. Guard against short/empty
  // values that would over-redact innocuous substrings.
  for (const secret of [...knownSecrets]
    .filter((s) => s && s.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, "[REDACTED_JWT]")
    .replace(/\bsk-[A-Za-z0-9-]{16,}/g, "[REDACTED_KEY]");
}

/**
 * Build the ChatGPT-subscription `auth.json` the spawned `codex` binary reads
 * from `CODEX_HOME`.
 *
 * Empirically (codex-cli 0.141): the CLI sends `tokens.access_token` **verbatim**
 * as the outbound `Authorization: Bearer` to `chatgpt.com` — it does NOT have to
 * be a JWT. `accessToken` is therefore the REAL subscription token, vended to the
 * caller at run/turn start (the CLI talks to the upstream directly and ignores
 * any base-url override, so there is no in-flight swap). The CLI DOES require
 * `tokens.id_token` to be a parseable JWT to boot — so that one is a
 * syntactically-valid UNSIGNED (`alg:none`) JWT, local-only and never transmitted,
 * with a far-future `exp` so the CLI never tries to refresh (a refresh would hit
 * the real OpenAI auth server with a bogus refresh token and fail). The real
 * `chatgpt_account_id` is written verbatim when the credential carries it.
 *
 * Pure (the caller passes `now`) so it is unit-testable and free of the
 * Date.now() ambient-clock dependency.
 */
export function buildCodexAuthJson(opts: {
  accessToken: string;
  accountId?: string | null;
  nowMs: number;
}): {
  auth_mode: string;
  tokens: { access_token: string; account_id: string; id_token: string; refresh_token: string };
  last_refresh: string;
} {
  const accountId = opts.accountId || PLACEHOLDER_ACCOUNT_ID;
  const idToken = [
    b64url({ alg: "none", typ: "JWT" }),
    b64url({
      exp: Math.floor(opts.nowMs / 1000) + 365 * 24 * 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      email: "chat@appstrate.local",
    }),
    "placeholder",
  ].join(".");
  return {
    auth_mode: "chatgpt",
    tokens: {
      // The REAL subscription access token (vended server-side). The CLI sends it
      // to chatgpt.com directly, so it must be the genuine token.
      access_token: opts.accessToken,
      account_id: accountId,
      // `last_refresh` (below) keeps the CLI from refreshing; this only needs to
      // be a valid-format JWT for the CLI to boot.
      id_token: idToken,
      refresh_token: "appstrate-managed",
    },
    last_refresh: new Date(opts.nowMs).toISOString(),
  };
}

/**
 * The credential vended to a first-party caller before driving the `codex`
 * binary — the shape the chat codex-vend endpoint and the runner's
 * `/credential-vend` both return (snake_case wire). `access_token` is the REAL
 * subscription token; `account_id` is the credential's `chatgpt_account_id`
 * when present. Shared so the on-disk-credential contract has one definition.
 */
export interface VendedCodexCredential {
  access_token: string;
  account_id?: string | null;
}

/**
 * Materialise an ephemeral `CODEX_HOME` holding the subscription `auth.json`
 * the spawned `codex` binary reads. The thin IO wrapper around
 * {@link buildCodexAuthJson}, shared by the chat engine and the AFPS runner so
 * the security-sensitive on-disk-credential lifecycle (real token, mode 0600)
 * has ONE audited implementation. The caller owns teardown — `rm(home, …)` in
 * its own `finally` — since only the caller knows the subprocess lifetime.
 *
 * `baseDir` defaults to the OS temp dir; the host-resident chat path passes a
 * RAM-backed dir (e.g. `/dev/shm`) so the real token is never written to a
 * physical disk at rest. (The containerised runner keeps the default — its temp
 * dir is wiped with the ephemeral container.)
 *
 * @returns the absolute path of the created `CODEX_HOME` directory.
 */
export async function writeCodexAuthHome(opts: {
  credential: VendedCodexCredential;
  nowMs: number;
  /** mkdtemp prefix, e.g. `"codex-chat-"` / `"codex-run-"` (for debuggability). */
  prefix?: string;
  /** Parent dir for the ephemeral home. Defaults to {@link tmpdir}. */
  baseDir?: string;
}): Promise<string> {
  const home = await mkdtemp(join(opts.baseDir ?? tmpdir(), opts.prefix ?? "codex-"));
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify(
      buildCodexAuthJson({
        accessToken: opts.credential.access_token,
        accountId: opts.credential.account_id,
        nowMs: opts.nowMs,
      }),
    ),
    { mode: 0o600 },
  );
  return home;
}

/**
 * Best-effort sweep of stale `codex-*` credential homes left behind by an
 * ungraceful kill (SIGKILL/OOM between {@link writeCodexAuthHome} and the
 * caller's `finally`). A real token can otherwise sit at rest until reboot.
 * Removes every `${prefix}*` dir under `baseDir` older than `maxAgeMs`. Called
 * at host boot. Never throws — a missing dir or a racing teardown is ignored.
 *
 * @returns the number of stale homes removed.
 */
export async function sweepStaleCodexHomes(opts: {
  baseDir: string;
  prefix: string;
  maxAgeMs: number;
  nowMs: number;
}): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(opts.baseDir);
  } catch {
    return 0; // baseDir absent (e.g. no /dev/shm) — nothing to sweep.
  }
  for (const name of entries) {
    if (!name.startsWith(opts.prefix)) continue;
    const path = join(opts.baseDir, name);
    try {
      const info = await stat(path);
      if (opts.nowMs - info.mtimeMs < opts.maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Racing teardown or permission — skip.
    }
  }
  return removed;
}

/**
 * Escape a string as a TOML basic string (double-quoted). Escapes the backslash
 * and quote, plus the control chars TOML requires (`\n`/`\r`/`\t`). Sufficient
 * for the values we emit (URLs, header values, env values, paths) — none of
 * which carry exotic control characters.
 */
function tomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/** A streamable-HTTP MCP server entry (the platform meta-tools surface). */
export interface CodexHttpMcpServer {
  /** Endpoint URL — codex auto-detects streamable HTTP transport from `url`. */
  url: string;
  /** Literal HTTP headers sent with every MCP request (auth + scoping). */
  headers?: Record<string, string>;
}

/**
 * Build the `config.toml` the spawned `codex` binary reads from `CODEX_HOME`
 * to discover its MCP servers. Codex's models-manager can't be reverse-proxied,
 * but its MCP client is independent — so this is how the codex engine reaches
 * the same tool surface the Claude engine gets through the Agent SDK's
 * `mcpServers`.
 *
 * Emits the `platform` (streamable HTTP) server — the platform meta-tools at
 * `/api/mcp/o/:org`. Auth + scoping ride as LITERAL `http_headers` (codex 0.141
 * sends them verbatim; the config.toml lives in the same 0600 ephemeral
 * `CODEX_HOME` as `auth.json`, so the forwarded credential gains no new at-rest
 * surface).
 *
 * `default_tools_approval_mode = "approve"` auto-approves the server's tools so
 * a non-interactive `codex exec` never blocks on a tool prompt (the sandbox flag
 * still governs codex's OWN file/exec tools, independently). The
 * `experimental_use_rmcp_client` / `[features]` flag is deliberately NOT emitted
 * — it is an unknown field at codex 0.141 (rejected under `--strict-config`),
 * and streamable-HTTP MCP works without it.
 *
 * Pure (no IO) so it is unit-testable; {@link writeCodexConfig} does the write.
 */
export function buildCodexConfigToml(opts: {
  platform?: CodexHttpMcpServer;
  /** Cap on the MCP server handshake (seconds). Default 20. */
  startupTimeoutSec?: number;
  /** Cap on a single MCP tool call (seconds). Default 120. */
  toolTimeoutSec?: number;
}): string {
  const startup = opts.startupTimeoutSec ?? 20;
  const toolTimeout = opts.toolTimeoutSec ?? 120;
  const blocks: string[] = [];

  if (opts.platform) {
    blocks.push(
      [
        "[mcp_servers.platform]",
        `url = ${tomlBasicString(opts.platform.url)}`,
        `startup_timeout_sec = ${startup}`,
        `tool_timeout_sec = ${toolTimeout}`,
        `default_tools_approval_mode = "approve"`,
      ].join("\n"),
    );
    const headers = opts.platform.headers ?? {};
    const headerKeys = Object.keys(headers);
    if (headerKeys.length > 0) {
      blocks.push(
        [
          "[mcp_servers.platform.http_headers]",
          ...headerKeys.map((k) => `${tomlBasicString(k)} = ${tomlBasicString(headers[k]!)}`),
        ].join("\n"),
      );
    }
  }

  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

/**
 * Write a `config.toml` into an existing ephemeral `CODEX_HOME` (mode 0600,
 * same posture as `auth.json`). No-op when `toml` is empty (no MCP servers).
 */
export async function writeCodexConfig(opts: { home: string; toml: string }): Promise<void> {
  if (!opts.toml) return;
  await writeFile(join(opts.home, "config.toml"), opts.toml, { mode: 0o600 });
}

/**
 * Curated environment for a spawned `codex` binary. Like
 * {@link ./claude-binary.ts}'s `buildClaudeSdkEnv`, this deliberately does NOT
 * forward the full `process.env` (that would leak platform secrets). It sets
 * `CODEX_HOME` (where the `auth.json` + config live), forwards the proxy vars
 * (so the binary's outbound traffic egresses through the sidecar forward-proxy),
 * and disables telemetry/update noise.
 *
 * There is no base-url override: the CLI talks to `chatgpt.com` directly
 * (ignoring `chatgpt_base_url`), and outbound traffic is constrained by the
 * sidecar's per-run egress allowlist rather than a gateway.
 */
export function buildCodexEnv(opts: {
  codexHome: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const passthrough = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [upper, lower] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["NO_PROXY", "no_proxy"],
  ] as const) {
    if (env[upper] && !env[lower]) env[lower] = env[upper];
    if (env[lower] && !env[upper]) env[upper] = env[lower];
  }
  // Keep the subprocess quiet + non-self-updating on a server.
  env.CODEX_DISABLE_UPDATE_CHECK = "1";
  // `extra` merged first; CODEX_HOME re-asserted LAST so it can't be redirected
  // (the placeholder auth.json + gateway config live there).
  const merged = { ...env, ...(opts.extra ?? {}) };
  merged.CODEX_HOME = opts.codexHome;
  return merged;
}

/** A module-specifier resolver — `require.resolve`-shaped. Injected so the
 * package matrix is unit-testable without the binaries on disk. */
export type BinaryResolver = (specifier: string) => string;

/**
 * Build a {@link BinaryResolver} anchored at the caller's module scope. The
 * per-arch `@openai/codex-<plat>-<arch>` packages are optional dependencies of
 * `@openai/codex`, so they sit beside it in the store — we hop through the main
 * package first (exactly as the CLI's own shim does).
 */
export function makeCodexScopeResolver(metaUrl: string): BinaryResolver {
  const base = createRequire(metaUrl);
  return (specifier: string): string => {
    const cliEntry = base.resolve(CODEX_SCOPE);
    return createRequire(cliEntry).resolve(specifier);
  };
}

/**
 * The Rust target triple for `(platform, arch)` — the directory the per-arch
 * package nests its binary under (`vendor/<triple>/bin/codex`). Linux is
 * **musl** (the binaries OpenAI ships are statically linked against musl, so
 * they run on Alpine). Pure (no IO).
 */
export function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    return null;
  }
  return null;
}

/** Per-arch package name for `(platform, arch)`. Pure (no IO). */
export function codexBinaryPackage(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "linux":
    case "darwin":
    case "win32":
      return `${CODEX_SCOPE}-${platform}-${arch}`;
    default:
      return null;
  }
}

/** Binary file name inside a per-arch package (`codex.exe` on Windows). */
export function codexBinaryFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

/**
 * Resolve the absolute path to the prebuilt `codex` binary for the current
 * host. `resolve` is REQUIRED — resolution is scope-relative; callers build one
 * with {@link makeCodexScopeResolver} anchored at their own module. Throws a
 * descriptive error when the per-arch package isn't installed.
 */
export function resolveCodexBinary(opts: {
  resolve: BinaryResolver;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  const pkg = codexBinaryPackage(platform, arch);
  const triple = codexTargetTriple(platform, arch);
  if (!pkg || !triple) {
    throw new Error(`No Codex binary package for ${platform}/${arch}.`);
  }
  const specifier = `${pkg}/vendor/${triple}/bin/${codexBinaryFileName(platform)}`;
  try {
    return opts.resolve(specifier);
  } catch {
    throw new Error(
      `Could not resolve the Codex native binary for ${platform}/${arch}. ` +
        `Tried: ${specifier}. Ensure the matching '${pkg}' optional dependency ` +
        `of '${CODEX_SCOPE}' is installed.`,
    );
  }
}

/**
 * Split a byte stream into newline-delimited, trimmed, non-empty strings
 * (UTF-8), flushing any unterminated tail. Used to read the `codex exec --json`
 * NDJSON event stream off the subprocess stdout — shared by the chat engine
 * (`module-chat`) and the AFPS runner (`runner-codex`).
 */
export async function* readNdjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) yield tail;
}

/**
 * Codex CLI usage counters (`turn.completed.usage`, codex-cli 0.141). Shared
 * by both codex event mappers (chat UI-stream + AFPS runner) so the CLI wire
 * contract has one definition.
 */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * A single `codex exec --json` NDJSON event (structural — only the fields the
 * mappers read). A superset of both mappers' needs: `item.command` + the index
 * signature are used by the runner mapper, the chat mapper reads a subset.
 */
export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    /** mcp_tool_call: the MCP server name (e.g. "platform"). */
    server?: string;
    /** mcp_tool_call: the bare tool name (no `mcp__server__` prefix). */
    tool?: string;
    /** mcp_tool_call: the call arguments (JsonValue; defaults to `{}`). */
    arguments?: unknown;
    /** mcp_tool_call (completed): the MCP CallToolResult payload. */
    result?: { content?: unknown[]; structured_content?: unknown } | null;
    /** mcp_tool_call (failed): the error. */
    error?: { message?: string } | null;
    /** mcp_tool_call: "in_progress" | "completed" | "failed". */
    status?: string;
    [k: string]: unknown;
  };
  usage?: CodexUsage;
  error?: { message?: string } | string;
  message?: string;
}

/** Parse one NDJSON line, returning `null` instead of throwing on malformed JSON. */
export function safeParseJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
