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
 *   - `"published"` → execute the latest published version (the `latest`
 *                     dist-tag, falling back to the highest version id).
 *                     404 `no_published_version` when nothing is published.
 *   - anything else → 3-step resolution (exact version → dist-tag → semver
 *                     range) via {@link getVersionDetail}. 404 when nothing
 *                     matches.
 *   - omitted       → **published when at least one version exists, draft
 *                     otherwise.** This is the documented default for API /
 *                     MCP / CLI / schedule callers: "run what was published"
 *                     is the least surprising semantics for programmatic
 *                     callers validating an agent. The editor UI passes
 *                     `version=draft` explicitly so test-runs keep executing
 *                     the working copy.
 *
 * System agents have no published versions (their definition ships with the
 * platform), so any selector is ignored and the loaded definition runs as-is
 * — same behavior the route always had.
 *
 * When a published version is selected, the returned `overrideVersionLabel`
 * carries the concrete semver: `buildRunContext` persists it as the run's
 * `version_label` with `version_dirty: false`, and the run serializer derives
 * `version_ref` from that pair (see `deriveVersionRef` in state/runs.ts).
 *
 * Known scope limit (refs #588): substituting the published manifest + prompt
 * pins the agent definition itself, but skill dependencies still resolve
 * through `DraftPackageCatalog` on the run hot path — the org working-copy
 * model. Pinning the full transitive closure is the #588 follow-up.
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
   * draft runs — `buildRunContext` then derives `version_label` +
   * `version_dirty` from the latest-version heuristic as before.
   */
  overrideVersionLabel?: string;
}

/** Build the effective LoadedPackage for a resolved published version. */
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
      if (sel === VERSION_SELECTOR_PUBLISHED) {
        throw new ApiError({
          status: 404,
          code: "no_published_version",
          title: "No Published Version",
          detail: `Agent '${agent.id}' has no published version — publish one or run with version=draft`,
        });
      }
      // Default path: never-published agents run their draft.
      return { agent };
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
