// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve which agent definition a run executes — the mutable draft or a
 * published `package_versions` snapshot (#636).
 *
 * Selector grammar (snake_case wire value of `?version=` on the run route
 * and `version_override` on schedules):
 *
 *   - `"draft"`     → execute the live draft (`packages.draft_manifest` /
 *                     `draft_content`) — the editor working copy.
 *   - `"published"` → execute the version selected by the `latest` dist-tag.
 *                     404 `no_published_version` when nothing is published.
 *   - anything else → 3-step resolution (exact version → dist-tag → semver
 *                     range) via {@link getVersionDetail}. 404 when nothing
 *                     matches.
 *   - omitted       → **strictly identical to `"published"`** (latest
 *                     published; 404 `no_published_version` when none). One
 *                     unified default for every caller — API / MCP / CLI /
 *                     schedule AND the dashboard transport: "run what was
 *                     published" is the least-surprising, reproducible default
 *                     for programmatic use. The working copy is NEVER an
 *                     implicit default: running it is opt-in via the explicit
 *                     `draft` selector (the editor UI passes it explicitly).
 *                     This keeps API and front coherent on every selector —
 *                     `draft` is the one editor-only capability, always
 *                     requested by name, never silently inferred.
 *
 * System agents have no published versions (their definition ships with the
 * platform), so any selector is ignored and the loaded definition runs as-is
 * — same behavior the route always had.
 *
 * When a published version is selected, the returned `overrideVersionLabel`
 * carries the concrete semver: run creation persists it as both the run's
 * `version_label` and `version_ref`.
 *
 * Scope: this resolver pins the agent's OWN definition (manifest + prompt) to
 * the selected version. It derives nothing: the readiness gate projects the
 * declared skills off the effective manifest itself (#878). The transitive
 * skill closure that ships to the container is pinned separately, on the run
 * hot path, by `RunPackageCatalog` (#666) — it resolves each
 * `dependencies.skills` entry against PUBLISHED versions honoring the manifest
 * pin, so a dependency's mutable draft never leaks into a run. Integration /
 * mcp-server spawns are frozen by the shared run-pipeline dependency resolver
 * before the sidecar receives its spawn plan (#686).
 */

import { ApiError, notFound } from "../lib/errors.ts";
import { getLatestVersionInfo, getVersionDetail } from "./package-versions.ts";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";

// Both keywords are reserved dist-tag names (`isProtectedTag` in
// `@appstrate/core/dist-tags`): they resolve here BEFORE dist-tag lookup,
// so a dist-tag named "draft" or "published" would be permanently shadowed —
// tag creation rejects them.
/** Keyword selecting the live draft definition. */
export const VERSION_SELECTOR_DRAFT = "draft";
/** Keyword selecting the latest published version. */
export const VERSION_SELECTOR_PUBLISHED = "published";

export interface ResolvedRunAgent {
  /** The agent definition the run will execute (draft or version snapshot). */
  agent: LoadedPackage;
  /**
   * Concrete semver of the executed published version. Undefined when the
   * draft runs — run creation then records `version_ref: "draft"` and keeps
   * `version_label` as the latest published base when one exists.
   */
  overrideVersionLabel?: string;
}

/**
 * Build the effective LoadedPackage for a resolved published version.
 *
 * A `LoadedPackage` carries only what the definition SAYS (manifest + prompt),
 * so swapping those two fields swaps the definition wholesale — nothing
 * derived from the draft manifest rides along (#878).
 */
function substituteVersion(
  agent: LoadedPackage,
  detail: { version: string; manifest: Record<string, unknown>; prompt: string | null },
): ResolvedRunAgent {
  return {
    agent: {
      ...agent,
      // Version manifest replaces the draft manifest entirely.
      manifest: detail.manifest as unknown as AgentManifest,
      prompt: detail.prompt ?? agent.prompt,
    },
    overrideVersionLabel: detail.version,
  };
}

/**
 * Resolve the `version` selector for a run trigger into the effective agent
 * definition. Throws `ApiError` (404) when an explicit selector cannot be
 * satisfied — never silently falls back to the draft.
 */
export async function resolveAgentRunVersion(
  agent: LoadedPackage,
  selector: string | undefined,
): Promise<ResolvedRunAgent> {
  // System agents ship their definition with the platform — no published
  // versions exist, the selector is ignored (pre-existing route behavior).
  if (agent.source === "system") return { agent };

  // Empty string ⇒ treated as omitted (query params arrive as "" easily).
  const sel = selector?.trim() || undefined;

  if (sel === VERSION_SELECTOR_DRAFT) return { agent };

  if (sel === undefined || sel === VERSION_SELECTOR_PUBLISHED) {
    const latest = await getLatestVersionInfo(agent.id).catch(() => null);
    if (!latest) {
      // omit ≡ published — no silent draft fallback. A never-published agent
      // run without a selector is an explicit error, not a surprise draft
      // execution; the working copy is opt-in via `version=draft` only.
      throw new ApiError({
        status: 404,
        code: "no_published_version",
        title: "No Published Version",
        detail: `Agent '${agent.id}' has no published version — publish one or run with version=draft`,
      });
    }
    const detail = await getVersionDetail(agent.id, latest.version);
    if (!detail) {
      throw notFound(`Version '${latest.version}' of '${agent.id}' is not available`);
    }
    return substituteVersion(agent, detail);
  }

  // Explicit spec: exact version → dist-tag → semver range.
  const detail = await getVersionDetail(agent.id, sel);
  if (!detail) {
    throw notFound(`Version '${sel}' not found`);
  }
  return substituteVersion(agent, detail);
}
