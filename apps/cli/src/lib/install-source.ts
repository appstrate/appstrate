// SPDX-License-Identifier: Apache-2.0

/**
 * Build-time stamp identifying which distribution channel produced this CLI.
 *
 * Two channels currently ship `appstrate`:
 *   - `curl`: the signed binary released via `curl -fsSL https://get.appstrate.dev | bash`
 *     (built by `.github/workflows/release.yml` with `bun build --compile`).
 *   - `bun`: the npm package consumed via `bun install -g appstrate` / `bunx appstrate`
 *     (built by `.github/workflows/publish-cli.yml` via `npm pack` → `bun run build`).
 *
 * The two artefacts are produced by separate workflows and never copied across
 * channels, so a build-time stamp is honest by construction. Source checkouts
 * (`bun run dev`, `bun apps/cli/src/cli.ts`) report `unknown` and let runtime
 * heuristics (e.g. `process.execPath` in `appstrate doctor`) take over.
 *
 * Implementation: `bun build --define '__APPSTRATE_INSTALL_SOURCE__="<channel>"'`
 * substitutes the identifier with a string literal at bundle time. The `typeof`
 * guard makes the lookup safe in dev where the identifier is undefined — `typeof`
 * never throws on missing globals, so we gracefully fall through to `"unknown"`.
 */

declare const __APPSTRATE_INSTALL_SOURCE__: string;

export type InstallSource = "curl" | "bun" | "unknown";

function resolveInstallSource(): InstallSource {
  // `typeof` on a missing identifier returns "undefined" without throwing,
  // unlike a bare reference. Required because the identifier is replaced
  // by `bun build --define` only in workflow builds — dev runs leave it
  // undefined and a bare reference would ReferenceError at module load.
  if (typeof __APPSTRATE_INSTALL_SOURCE__ !== "string") {
    return "unknown";
  }
  const stamp = __APPSTRATE_INSTALL_SOURCE__;
  if (stamp === "curl" || stamp === "bun" || stamp === "unknown") {
    return stamp;
  }
  return "unknown";
}

/** Channel that produced this binary, or `"unknown"` for source/dev builds. */
export const INSTALL_SOURCE: InstallSource = resolveInstallSource();

/** Human-readable upgrade hint for the detected channel. */
export function upgradeHint(source: InstallSource = INSTALL_SOURCE): string {
  switch (source) {
    case "curl":
      return "curl -fsSL https://get.appstrate.dev | bash";
    case "bun":
      return "bun update -g appstrate";
    case "unknown":
      return "reinstall via curl -fsSL https://get.appstrate.dev | bash, or `bun update -g appstrate`";
  }
}
