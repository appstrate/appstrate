// SPDX-License-Identifier: Apache-2.0

/**
 * Effective agent manifest for an ACTIVE run — the single post-kickoff read
 * path for "what does the running agent's definition say?".
 *
 * At kickoff, `resolveAgentRunVersion` (#636) pins the run's definition to a
 * published `package_versions` snapshot and stamps the concrete semver on
 * `runs.version_ref` (`"draft"` when the working copy runs). Every runtime
 * surface that consults the agent manifest AFTER kickoff — the sidecar
 * credential guards, the mcp-server bundle guard, finalize's output-schema
 * validation — must read that SAME definition. Re-reading the mutable draft
 * lets a post-publish draft edit retroactively change a pinned run's
 * authorization set or output contract: a dependency removed from the draft
 * 404'd the credential fetch of a scheduled run pinned to a version that
 * still declares it (the `@tractr/fathom-glenn` incident), and a dependency
 * newly added to the draft would widen what a leaked run token of an old
 * pinned run may enumerate.
 */

import { getPackage } from "./package-catalog.ts";
import { getExactVersionManifest } from "./package-versions.ts";
import type { AgentManifest } from "../types/index.ts";

export interface RunEffectiveAgent {
  /** Package id — stable across draft and pinned reads. */
  id: string;
  /** The manifest of the definition the run executes (pinned snapshot or live draft). */
  manifest: AgentManifest;
}

/**
 * Detail string for "the definition this run executes can no longer be read".
 * Shared by every caller so the sidecar, the mcp-server bundle guard and
 * finalize all name the SAME cause and the SAME remedy — the previous
 * "Agent not found" named a cause that was never true (the agent row is
 * usually still there; it is the pinned `package_versions` snapshot that is
 * gone).
 */
export function runDefinitionGoneDetail(run: {
  packageId: string;
  versionRef: string | null;
}): string {
  return (
    `The definition this run executes is no longer readable: version ` +
    `'${run.versionRef ?? "draft"}' of package '${run.packageId}' was deleted while ` +
    `the run was in flight. Re-publish that version to make the pinned definition ` +
    `readable again, or start a new run against the current definition.`
  );
}

/**
 * Load the manifest of the definition a run executes.
 *
 * - `version_ref = "draft"` (editor runs, system agents, inline shadow
 *   packages, legacy rows) → the live draft.
 * - concrete semver → the `package_versions` snapshot for that exact
 *   version.
 *
 * Returns null when that definition is no longer readable — either the
 * package row is gone (agent deleted mid-run; `package_versions` rows cascade
 * with it) or the pinned version row is gone (version deleted after kickoff).
 * There is deliberately NO draft fallback for the pinned case: serving the
 * mutable draft is exactly the substitution the module header forbids, and it
 * did so silently — a run token's authorization set and a run's output
 * contract would both have been quietly re-derived from a definition the run
 * never agreed to. Callers MUST treat null as fatal for the operation at
 * hand and surface {@link runDefinitionGoneDetail}.
 */
export async function getRunEffectiveAgent(run: {
  packageId: string;
  orgId: string;
  versionRef: string | null;
}): Promise<RunEffectiveAgent | null> {
  // `includeEphemeral` keeps inline-run shadow packages addressable.
  const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
  if (!agent) return null;

  const versionRef = run.versionRef ?? "draft";
  // System agents ship their definition with the platform and have no
  // published versions — the draft row IS the effective definition.
  if (versionRef === "draft" || agent.source === "system") {
    return { id: agent.id, manifest: agent.manifest };
  }

  const pinned = await getExactVersionManifest(run.packageId, versionRef);
  if (!pinned) return null;
  return { id: agent.id, manifest: pinned as unknown as AgentManifest };
}
