// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Resolve the prebuilt `codex` native binary that backs the OpenAI Codex CLI,
 * plus the placeholder `auth.json` + curated env a host needs to drive it
 * headlessly against the credential-injection gateway.
 *
 * The Codex counterpart of {@link ./claude-binary.ts}. Codex is a single Rust
 * binary (not an npm SDK with a `query()` function), so hosts drive it as a
 * subprocess: `codex exec --json -c chatgpt_base_url=<gateway> …`. This module
 * holds the universal, IO-free parts:
 *   - the per-arch package matrix (so `bun install` of `@openai/codex` places
 *     the matching binary; we resolve whichever variant is present),
 *   - the placeholder `auth.json` builder (ChatGPT-subscription mode), and
 *   - the curated subprocess env.
 *
 * ToS posture (identical to claude): the official `codex` binary signs its OWN
 * client fingerprint (`originator: codex_exec`) and sends its own
 * `chatgpt-account-id`. We forge NOTHING — we only point it at a gateway
 * (`chatgpt_base_url`) that swaps a placeholder bearer for the real
 * subscription token server-side. The spawned binary only ever holds a
 * placeholder access token; the real token never enters its environment.
 *
 * The linux per-arch binaries are **musl-static**
 * (`*-unknown-linux-musl`), so they run on the Alpine production image with no
 * glibc shim — unlike many Rust CLIs. This module imports nothing from
 * `@openai/codex`; it resolves package-specifier *strings* through an injected
 * resolver, so `@appstrate/core` gains no dependency on the Codex CLI.
 */

import { createRequire } from "node:module";

const CODEX_SCOPE = "@openai/codex";

/** A dummy UUID written into the placeholder `auth.json`. The gateway overwrites
 * the outbound `chatgpt-account-id` header with the credential's real account
 * id, so this value never reaches the upstream — it only has to be present so
 * the CLI boots in ChatGPT mode. */
const PLACEHOLDER_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/** Base64url without padding (Bun/Node `base64url` encoding). */
function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Build the ChatGPT-subscription `auth.json` the spawned `codex` binary reads
 * from `CODEX_HOME`.
 *
 * Empirically (codex-cli 0.141): the CLI sends `tokens.access_token` **verbatim**
 * as the outbound `Authorization: Bearer` to `chatgpt_base_url` — it does NOT
 * have to be a JWT. So `accessToken` is the gateway-auth token (a chat-loopback
 * token for the chat path; a dummy for the runner's sidecar, which swaps by
 * configured credential). The CLI DOES require `tokens.id_token` to be a
 * parseable JWT to boot — so that one is a syntactically-valid unsigned JWT with
 * a far-future `exp` (so the CLI never tries to refresh — a refresh would hit
 * the real OpenAI auth server with a bogus refresh token and fail). The gateway
 * swaps the placeholder bearer for the real subscription token + stamps the real
 * `chatgpt-account-id` server-side, so neither the real token nor the real
 * account id ever lives in the subprocess.
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
 * Curated environment for a spawned `codex` binary. Like
 * {@link ./claude-binary.ts}'s `buildClaudeSdkEnv`, this deliberately does NOT
 * forward the full `process.env` (that would leak platform secrets). It sets
 * `CODEX_HOME` (where the placeholder `auth.json` + config live), forwards the
 * proxy vars (so the binary's outbound traffic egresses through the sidecar
 * forward-proxy), and disables telemetry/update noise.
 *
 * The gateway base URL is NOT an env var — it is passed on the command line
 * (`-c chatgpt_base_url=…`), so it can't be overridden by ambient env.
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
