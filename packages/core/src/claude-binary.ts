// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Resolve the prebuilt `claude` native binary that backs the Claude Agent
 * SDK, so the SDK can be driven via `pathToClaudeCodeExecutable` instead of
 * self-extracting its bundled binary at runtime.
 *
 * Shared by every host that drives `@anthropic-ai/claude-agent-sdk` under
 * Bun — currently the chat engine (`@appstrate/module-chat`) and the agent
 * runner (`@appstrate/runner-claude`). The per-arch package matrix and
 * fall-through logic are universal and live here; the only call-site-specific
 * piece is *where* the SDK is installed, so each consumer anchors resolution
 * at its own module scope via {@link makeSdkScopeResolver}.
 *
 * Why we point at the prebuilt binary explicitly:
 *   - Under **Bun**, the SDK's own bundle-extraction path throws
 *     `Decompression error: ZlibError` (it assumes a Node bunfs layout). Hosts
 *     run under Bun, so they MUST bypass that extraction — handing the SDK the
 *     already-unpacked per-arch binary skips it entirely (verified under Bun
 *     in the Phase 0 spike).
 *   - The per-arch binaries ship as `os`/`cpu`/`libc`-gated optional
 *     dependencies of `@anthropic-ai/claude-agent-sdk`, so `bun install`
 *     places exactly the one matching the host (darwin-arm64 in dev, the musl
 *     linux variant in the Alpine production image). We resolve whichever
 *     variant is present.
 *
 * This module imports nothing from the SDK — it only resolves package
 * specifier *strings* through an injected resolver, so `@appstrate/core` gains
 * no dependency on the Agent SDK.
 */

import { createRequire } from "node:module";

const SDK_SCOPE = "@anthropic-ai/claude-agent-sdk";

/**
 * Curated environment for a spawned `claude` Agent SDK binary. Shared by every
 * host that drives the SDK as a subprocess (the chat engine + the agent
 * runner).
 *
 * Security posture: deliberately does NOT forward the full `process.env` —
 * that would leak platform secrets (DATABASE_URL, signing keys, …) into the
 * subprocess. Only the bits the binary needs to run, plus the gateway pointers
 * and the flags that keep it from phoning home or picking up an ambient API
 * key (which would flip it onto the API-key path instead of the subscription
 * bearer the gateway injects).
 *
 * - `baseUrl` → `ANTHROPIC_BASE_URL` (the non-forging credential-injection
 *   gateway).
 * - `placeholderToken` → `ANTHROPIC_AUTH_TOKEN` (the gateway swaps it for the
 *   real subscription token server-side).
 * - `extra` is merged last, for host-specific additions.
 */
export function buildClaudeSdkEnv(opts: {
  baseUrl: string;
  placeholderToken: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  // Forward the proxy vars so the spawned `claude` binary's native tools
  // (Bash/WebFetch) egress through the sidecar forward-proxy — the same
  // outbound isolation the Pi runner gets. Without these the subprocess would
  // reach the internet directly, bypassing the sidecar's allowlist/MITM.
  // Both casings: curl/libcurl read lowercase, Node/Bun read uppercase.
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
  // The container sets only the uppercase proxy vars; mirror them to lowercase
  // so curl/wget (which prefer lowercase) inside native Bash also egress through
  // the sidecar. Mirror lowercase→uppercase too for completeness.
  for (const [upper, lower] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["NO_PROXY", "no_proxy"],
  ] as const) {
    if (env[upper] && !env[lower]) env[lower] = env[upper];
    if (env[lower] && !env[upper]) env[upper] = env[lower];
  }
  // Keep the subscription binary quiet and non-self-updating in a server.
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  // `extra` is merged first so callers can add env, then the
  // credential-isolation keys are re-asserted LAST: `extra` must never be able
  // to redirect the binary's upstream (ANTHROPIC_BASE_URL) or swap its
  // credential (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY) — that would defeat
  // the no-secret-leak posture this builder exists to guarantee.
  const merged = { ...env, ...(opts.extra ?? {}) };
  merged.ANTHROPIC_BASE_URL = opts.baseUrl;
  merged.ANTHROPIC_AUTH_TOKEN = opts.placeholderToken;
  merged.ANTHROPIC_API_KEY = "";
  return merged;
}

/**
 * A module-specifier resolver — `require.resolve`-shaped. Injected so the
 * algorithm is unit-testable without the 200 MB binaries on disk, and so each
 * consumer can anchor resolution at its own `node_modules` scope.
 */
export type BinaryResolver = (specifier: string) => string;

/**
 * Build a {@link BinaryResolver} anchored at the caller's module scope.
 *
 * The `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` packages are
 * *optional dependencies of the main SDK*, so the package manager co-locates
 * them with it (a sibling in the store), NOT in the caller's own
 * `node_modules`. A plain `require.resolve` anchored at the caller therefore
 * can't see them — we must hop through the main SDK first, exactly as the SDK
 * does internally when it self-resolves its binary.
 *
 * Pass `import.meta.url` from the consuming module so the first hop
 * (`require.resolve('@anthropic-ai/claude-agent-sdk')`) resolves against the
 * scope where that consumer actually installed the SDK.
 */
export function makeSdkScopeResolver(metaUrl: string): BinaryResolver {
  const base = createRequire(metaUrl);
  return (specifier: string): string => {
    const sdkEntry = base.resolve(SDK_SCOPE);
    return createRequire(sdkEntry).resolve(specifier);
  };
}

/**
 * Candidate per-arch package names for `(platform, arch)`, in resolution
 * preference order. Linux lists the **musl** variant first — the production
 * image is `oven/bun:*-alpine` (musl) — then glibc as a fallback for a
 * Debian/Ubuntu host. Only the libc variant `bun install` actually placed
 * will resolve; the order just decides which we try first.
 *
 * Pure (no IO) so the platform matrix is unit-testable without the 200 MB
 * binaries installed.
 */
export function candidateBinaryPackages(platform: NodeJS.Platform, arch: string): string[] {
  switch (platform) {
    case "linux":
      return [`${SDK_SCOPE}-linux-${arch}-musl`, `${SDK_SCOPE}-linux-${arch}`];
    case "darwin":
      return [`${SDK_SCOPE}-darwin-${arch}`];
    case "win32":
      return [`${SDK_SCOPE}-win32-${arch}`];
    default:
      return [];
  }
}

/** Binary file name inside a per-arch package (`claude.exe` on Windows). */
export function binaryFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * Resolve the absolute path to the prebuilt `claude` binary for the current
 * host, trying each candidate package until one resolves.
 *
 * `resolve` is REQUIRED — there is no universal default because resolution is
 * inherently scope-relative; callers build one with {@link makeSdkScopeResolver}
 * anchored at their own module. Tests pass a hand-rolled resolver to exercise
 * the candidate matrix without the binaries on disk.
 *
 * Throws a descriptive error (listing the packages it tried) when none is
 * present — that means the host's per-arch binary package wasn't installed,
 * which would otherwise surface as an opaque SDK spawn failure.
 */
export function resolveClaudeCodeBinary(opts: {
  resolve: BinaryResolver;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  const packages = candidateBinaryPackages(platform, arch);
  const fileName = binaryFileName(platform);
  const tried: string[] = [];

  for (const pkg of packages) {
    const specifier = `${pkg}/${fileName}`;
    tried.push(specifier);
    try {
      return opts.resolve(specifier);
    } catch {
      // Not installed for this libc/arch — try the next candidate.
    }
  }

  throw new Error(
    `Could not resolve the Claude Code native binary for ${platform}/${arch}. ` +
      `Tried: ${tried.join(", ") || "<no candidates for this platform>"}. ` +
      `Ensure the matching '${SDK_SCOPE}-*' optional dependency is installed ` +
      `(it is os/cpu/libc-gated; the production Alpine image needs the '-musl' variant).`,
  );
}
