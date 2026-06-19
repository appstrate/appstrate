// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the prebuilt `claude` native binary that backs the Claude Agent
 * SDK, so the SDK can be driven via `pathToClaudeCodeExecutable` instead of
 * self-extracting its bundled binary at runtime.
 *
 * Why we point at the prebuilt binary explicitly:
 *   - Under **Bun**, the SDK's own bundle-extraction path throws
 *     `Decompression error: ZlibError` (it assumes a Node bunfs layout).
 *     apps/api runs under Bun, so we MUST bypass that extraction. Handing
 *     the SDK the already-unpacked per-arch binary skips it entirely —
 *     verified working under Bun in the Phase 0 spike.
 *   - The per-arch binaries ship as `os`/`cpu`/`libc`-gated optional
 *     dependencies of `@anthropic-ai/claude-agent-sdk`, so `bun install`
 *     places exactly the one matching the host (darwin-arm64 in dev, the
 *     musl linux variant in the Alpine production image). We resolve
 *     whichever variant is present.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SDK_SCOPE = "@anthropic-ai/claude-agent-sdk";

/**
 * Resolve a per-arch binary specifier from the **main SDK's** module scope.
 *
 * The `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` packages are
 * *optional dependencies of the main SDK*, so the package manager co-locates
 * them with it (a sibling in the store), NOT in our own `node_modules`. A
 * plain `require.resolve` anchored at this file therefore can't see them —
 * we must hop through the main SDK first, exactly as the SDK does internally
 * when it self-resolves its binary.
 */
function resolveFromSdkScope(specifier: string): string {
  const sdkEntry = require.resolve(SDK_SCOPE);
  return createRequire(sdkEntry).resolve(specifier);
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
 * host, trying each candidate package until one resolves. `resolve` is
 * injectable so the resolution algorithm can be unit-tested without the
 * binaries on disk; it defaults to this module's `require.resolve`.
 *
 * Throws a descriptive error (listing the packages it tried) when none is
 * present — that means the host's per-arch binary package wasn't installed,
 * which would otherwise surface as an opaque SDK spawn failure.
 */
export function resolveClaudeCodeBinary(
  opts: {
    platform?: NodeJS.Platform;
    arch?: string;
    resolve?: (specifier: string) => string;
  } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const resolve = opts.resolve ?? resolveFromSdkScope;

  const packages = candidateBinaryPackages(platform, arch);
  const fileName = binaryFileName(platform);
  const tried: string[] = [];

  for (const pkg of packages) {
    const specifier = `${pkg}/${fileName}`;
    tried.push(specifier);
    try {
      return resolve(specifier);
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
