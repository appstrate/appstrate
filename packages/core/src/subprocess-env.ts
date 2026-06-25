// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared building blocks for spawning a vendor CLI/SDK binary (the Claude Agent
 * SDK) under Bun with the platform's credential-isolation posture. The binary
 * needs two things — a curated, secret-free environment that still egresses
 * through the sidecar proxy, and a scope-anchored resolver for its per-arch
 * optional-dependency binary — so the mechanics live here once. The
 * engine-specific bits (which credential keys to re-assert, which telemetry
 * flags to silence, the per-arch package matrix) stay in `claude-binary.ts`.
 *
 * This module imports nothing from either SDK — it only manipulates env strings
 * and resolves package-specifier strings through an injected resolver — so
 * `@appstrate/core` gains no dependency on the vendor packages.
 */

// node:module — `createRequire` is the only way to anchor `require.resolve` at a
// given module scope (hopping through the vendor package to reach its per-arch
// optional-dep binary). Bun exposes no equivalent scope-anchored resolver, so
// this Node import is required.
import { createRequire } from "node:module";

/**
 * Curated base environment for a spawned vendor binary: the minimal vars the
 * binary needs to run, plus the proxy vars (both casings) so its native tools
 * (Bash/curl/WebFetch) egress through the sidecar forward-proxy — the same
 * outbound isolation the Pi runner gets.
 *
 * Deliberately does NOT forward the full `process.env`: that would leak platform
 * secrets (DATABASE_URL, signing keys, …) into the subprocess. Callers layer
 * their engine-specific flags + credential keys on top of this base, re-asserting
 * the credential keys LAST so a caller's `extra` can never redirect the binary's
 * upstream or swap its credential.
 */
export function buildIsolatedSubprocessEnv(): Record<string, string> {
  // curl/libcurl read lowercase proxy vars, Node/Bun read uppercase — forward
  // both.
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
  // (and back) so tools that prefer either casing all egress through the proxy.
  for (const [upper, lower] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["NO_PROXY", "no_proxy"],
  ] as const) {
    if (env[upper] && !env[lower]) env[lower] = env[upper];
    if (env[lower] && !env[upper]) env[upper] = env[lower];
  }
  return env;
}

/**
 * A module-specifier resolver — `require.resolve`-shaped. Injected so the
 * per-arch package matrix is unit-testable without the (large) binaries on
 * disk, and so each consumer can anchor resolution at its own `node_modules`
 * scope.
 */
export type BinaryResolver = (specifier: string) => string;

/**
 * Build a {@link BinaryResolver} anchored at the caller's module scope, hopping
 * through `scope` first.
 *
 * A vendor's per-arch binaries ship as `os`/`cpu`/`libc`-gated OPTIONAL
 * dependencies of its main package, so the package manager co-locates them with
 * that package (a sibling in the store), NOT in the caller's own
 * `node_modules`. A plain `require.resolve` anchored at the caller therefore
 * can't see them — we must hop through the main package first, exactly as the
 * vendor's own shim does when it self-resolves its binary.
 *
 * Pass `import.meta.url` from the consuming module so the first hop
 * (`require.resolve(scope)`) resolves against the scope where that consumer
 * actually installed the package.
 */
export function makeScopeResolver(scope: string, metaUrl: string): BinaryResolver {
  const base = createRequire(metaUrl);
  return (specifier: string): string => {
    const scopeEntry = base.resolve(scope);
    return createRequire(scopeEntry).resolve(specifier);
  };
}
