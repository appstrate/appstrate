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

/** The definition was read — the run's output contract and dep set are knowable. */
export interface RunEffectiveAgentFound {
  readonly status: "ok";
  /** Package id — stable across draft and pinned reads. */
  readonly id: string;
  /** The manifest of the definition the run executes (pinned snapshot or live draft). */
  readonly manifest: AgentManifest;
}

/**
 * STATE A — the package row is still there, but the `package_versions`
 * snapshot pinned by `runs.version_ref` is gone (that version was deleted
 * after kickoff). The run executed a definition nobody can read any more, so
 * its output contract and its authorization set are BOTH unknowable. Every
 * caller must fail loud: there is no safe substitute, and the mutable draft is
 * precisely the substitution the module header forbids.
 */
export interface RunPinnedVersionGone {
  readonly status: "version_deleted";
  readonly packageId: string;
  /** The concrete semver `runs.version_ref` pins — never "draft" here. */
  readonly versionRef: string;
}

/**
 * STATE B — the PACKAGE row itself is gone: the agent was deleted while the
 * run was in flight. This is a deliberate, designed state, not corruption —
 * `runs.package_id` is `ON DELETE SET NULL` and the run survives for
 * observability/billing (see the note at `run-event-ingestion.ts:138-152`,
 * which reconstructs a stable `@scope/name` from the INSERT-time snapshot).
 * No definition will ever come back, so "re-publish the version" is not a
 * remedy here — which is exactly why this is NOT state A with a different
 * label.
 */
export interface RunAgentGone {
  readonly status: "agent_deleted";
  /**
   * The agent identity recovered from the run row — the INSERT-time
   * `agentScope`/`agentName` snapshot, or the `"@deleted/unknown"` sentinel
   * when even that is absent (pre-snapshot legacy rows).
   */
  readonly packageId: string;
}

/**
 * Outcome of {@link getRunEffectiveAgent}. Three-way on purpose, and NOT the
 * `{ ok: true } | { ok: false; reason }` shape used elsewhere (e.g.
 * `resolveOne` in `integration-spawn-resolver.ts`): a bare boolean lets a
 * caller write `if (!res.ok) fail()` and re-collapse the two absent states,
 * which is the exact regression this shape exists to prevent. The two
 * "gone" branches carry different fields and different discriminants, and the
 * detail builders below accept ONE branch each — so producing a message
 * without first narrowing to a single state does not type-check.
 */
export type RunEffectiveAgentResult = RunEffectiveAgentFound | RunPinnedVersionGone | RunAgentGone;

/**
 * Detail string for STATE A. Names the deleted pinned version, the package it
 * belongs to, and the remedy that actually applies to it — the previous
 * "Agent not found" named a cause that was not even true, since the agent row
 * is still present in this state.
 */
export function runPinnedVersionGoneDetail(gone: RunPinnedVersionGone): string {
  return (
    `The definition this run executes is no longer readable: version ` +
    `'${gone.versionRef}' of package '${gone.packageId}' was deleted while ` +
    `the run was in flight. Re-publish that version to make the pinned definition ` +
    `readable again, or start a new run against the current definition.`
  );
}

/**
 * Detail string for STATE B. Deliberately does NOT offer state A's remedy:
 * the package row is gone, so there is no version to re-publish and no
 * "current definition" to re-run against.
 */
export function runAgentGoneDetail(gone: RunAgentGone): string {
  return (
    `The agent this run executes ('${gone.packageId}') was deleted while the run ` +
    `was in flight, so its definition can no longer be read. The run row is kept ` +
    `for observability; re-create the agent and start a new run.`
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
 * When the definition is not readable, the result says WHICH of the two
 * absent states applies — {@link RunPinnedVersionGone} (state A) or
 * {@link RunAgentGone} (state B) — because they call for opposite handling:
 * A is an anomaly with an unknowable contract, B is a designed, benign state
 * a run is allowed to finish in. There is deliberately NO draft fallback for
 * the pinned case: serving the mutable draft is exactly the substitution the
 * module header forbids, and it did so silently — a run token's authorization
 * set and a run's output contract would both have been quietly re-derived
 * from a definition the run never agreed to.
 */
export async function getRunEffectiveAgent(run: {
  packageId: string;
  orgId: string;
  versionRef: string | null;
}): Promise<RunEffectiveAgentResult> {
  // `includeEphemeral` keeps inline-run shadow packages addressable.
  const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
  // The package row is gone (or was never resolvable — the `@deleted/unknown`
  // sentinel lands here too): state B, whatever `version_ref` says. The
  // `package_versions` rows cascaded with it, so there is nothing further to
  // probe.
  if (!agent) return { status: "agent_deleted", packageId: run.packageId };

  const versionRef = run.versionRef ?? "draft";
  // System agents ship their definition with the platform and have no
  // published versions — the draft row IS the effective definition.
  if (versionRef === "draft" || agent.source === "system") {
    return { status: "ok", id: agent.id, manifest: agent.manifest };
  }

  const pinned = await getExactVersionManifest(run.packageId, versionRef);
  // Package present, pinned snapshot absent: state A.
  if (!pinned) return { status: "version_deleted", packageId: run.packageId, versionRef };
  return { status: "ok", id: agent.id, manifest: pinned as unknown as AgentManifest };
}
