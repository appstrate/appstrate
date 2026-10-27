// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve which agent definition a run executes — the mutable draft or a
 * published `package_versions` snapshot.
 *
 * Selector grammar (snake_case wire value of `?version=` on the run route
 * and `version_override` on schedules):
 *
 *   - `"draft"`     → execute the live draft (`packages.draft_manifest` /
 *                     `draft_content`) — the editor working copy.
 *   - `"published"` → execute the version selected by the `latest` dist-tag.
 *                     404 `no_published_version` when nothing is published.
 *   - anything else → 3-step resolution (exact version → dist-tag → semver
 *                     range) via {@link getVersionRow}. 404 when nothing
 *                     matches.
 *   - omitted       → `"published"`. There is no third answer: an
 *                     placement carries no version, so a space runs what its
 *                     author last published unless the caller asks for
 *                     something else.
 *
 * AUTHORITY is not decided here. `"draft"` is honoured as written, because the
 * draft is the author's working copy and every HTTP entry point has already
 * asked the one predicate that says who owns it
 * (`holdsPackageWriteAuthority`, `lib/package-access.ts`) and answered
 * `403 draft_not_writable` itself. Re-asking here would mean threading a Hono
 * context into a resolver the scheduler calls with none — and the scheduler
 * deliberately does NOT re-check: the authority was verified when the schedule
 * was created, the same way its `connection_overrides` were frozen then.
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
 * declared skills off the effective manifest itself. The transitive
 * skill closure that ships to the container is pinned separately, on the run
 * hot path, by `RunPackageCatalog` — it resolves each
 * `dependencies.skills` entry against PUBLISHED versions honoring the manifest
 * pin, so a dependency's mutable draft never leaks into a run. Integration /
 * mcp-server spawns are frozen by the shared run-pipeline dependency resolver
 * before the sidecar receives its spawn plan.
 */

import { ApiError, notFound } from "../lib/errors.ts";
import {
  getLatestVersionInfo,
  getVersionRow,
  readVersionArchive,
  requirePublishedPrompt,
  type VersionDetail,
} from "./package-versions.ts";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import type { DbOrTx } from "../lib/db-helpers.ts";

// Both keywords are reserved names (`isProtectedTag` in
// `@appstrate/core/dist-tags`): they resolve here BEFORE any dist-tag lookup,
// so a tag so named could never be reached. Nothing can create one anyway —
// `latest` is the only dist-tag this platform writes, at publish, and there is
// no route that names a tag. The reserved list is what
// `isValidDependencyOverride` checks a pin's VALUE against.
/** Keyword selecting the live draft definition. */
export const VERSION_SELECTOR_DRAFT = "draft";
/** Keyword selecting the latest published version. */
export const VERSION_SELECTOR_PUBLISHED = "published";

/** `runs.version_ref` of a resolved definition: its concrete semver, else `"draft"`. */
export function versionRefOf(overrideVersionLabel: string | undefined): string {
  return overrideVersionLabel ?? VERSION_SELECTOR_DRAFT;
}

type VersionRow = Omit<VersionDetail, "content">;

interface ResolvedRunAgent {
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
 * derived from the draft manifest rides along.
 */
function substituteVersion(
  agent: LoadedPackage,
  detail: Pick<VersionDetail, "version" | "manifest" | "content">,
): ResolvedRunAgent {
  return {
    agent: {
      ...agent,
      // Version manifest replaces the draft manifest entirely.
      manifest: detail.manifest as unknown as AgentManifest,
      prompt: requirePublishedPrompt(agent.id, detail),
    },
    overrideVersionLabel: detail.version,
  };
}

/**
 * The version `selector` picks for `agent`: its catalog row (manifest included, archive not
 * read), or `null` when the loaded definition itself runs (a system agent, or `"draft"`).
 * Throws `ApiError` (404) when a published selection cannot be satisfied — never a silent
 * draft fallback. The one selection {@link resolveAgentRunVersion} and
 * {@link resolveAgentRunManifest} share.
 */
async function selectRunVersion(
  agent: LoadedPackage,
  selector: string | undefined,
  executor?: DbOrTx,
): Promise<VersionRow | null> {
  // System agents ship their definition with the platform — no published
  // versions exist, the selector is ignored (pre-existing route behavior).
  if (agent.source === "system") return null;

  // Empty string ⇒ treated as omitted (query params arrive as "" easily).
  const sel = selector?.trim() || undefined;

  if (sel === VERSION_SELECTOR_DRAFT) return null;

  if (sel === undefined || sel === VERSION_SELECTOR_PUBLISHED) {
    const latest = await getLatestVersionInfo(agent.id, executor).catch(() => null);
    if (!latest) {
      // Nothing published — no silent draft fallback. An agent run without a
      // selector is an explicit error, not a surprise draft execution; the
      // working copy is opt-in via `version=draft` only.
      throw new ApiError({
        status: 404,
        code: "no_published_version",
        title: "No Published Version",
        detail: `Agent '${agent.id}' has no published version — publish one or run with version=draft`,
      });
    }
    const row = await getVersionRow(agent.id, latest.version, executor);
    if (!row) {
      throw notFound(`Version '${latest.version}' of '${agent.id}' is not available`);
    }
    return row;
  }

  // Explicit spec: exact version → dist-tag → semver range.
  const row = await getVersionRow(agent.id, sel, executor);
  if (!row) {
    throw notFound(`Version '${sel}' not found`);
  }
  return row;
}

/**
 * Resolve the `version` selector for a run trigger into the effective agent
 * definition. Throws `ApiError` (404) when an explicit selector cannot be
 * satisfied — never silently falls back to the draft — and 422
 * `version_artifact_unavailable` when the selected version's archive is unreadable.
 */
export async function resolveAgentRunVersion(
  agent: LoadedPackage,
  selector: string | undefined,
  executor?: DbOrTx,
): Promise<ResolvedRunAgent> {
  const row = await selectRunVersion(agent, selector, executor);
  if (!row) return { agent };
  // The version will run: its bytes go through the AFPS signature policy.
  const content = await readVersionArchive(agent.id, row.version, { forExecution: true });
  return substituteVersion(agent, { ...row, content });
}

/**
 * {@link resolveAgentRunVersion}'s selection, same 404s, for a caller that only reads what the
 * definition DECLARES: the selected version's manifest replaces the draft's, and its archive is
 * never read — no download, no signature check, so no prompt (and no 422 for an unreadable one).
 */
export async function resolveAgentRunManifest(
  agent: LoadedPackage,
  selector: string | undefined,
  executor?: DbOrTx,
): Promise<{ agent: Omit<LoadedPackage, "prompt">; overrideVersionLabel?: string }> {
  const row = await selectRunVersion(agent, selector, executor);
  if (!row) return { agent };
  return {
    agent: { ...agent, manifest: row.manifest as unknown as AgentManifest },
    overrideVersionLabel: row.version,
  };
}
