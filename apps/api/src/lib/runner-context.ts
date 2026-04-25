// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves a human-friendly label + classifier for the runner that
 * triggered a run. Stamped denormalized on `runs.runner_name` and
 * `runs.runner_kind` at INSERT time and never updated.
 *
 * Sources, in priority order:
 *
 *   1. Explicit headers `X-Appstrate-Runner-Name` / `X-Appstrate-Runner-Kind`
 *      sent by the caller (CLI, GitHub Action, custom integration).
 *      Trimmed and clamped to defang bad clients pushing multi-KB blobs
 *      into freshly-indexable text columns.
 *   2. Module-contributed resolver via `setRunnerResolver`. The OIDC
 *      module registers one that maps a JWT's `cli_family_id` claim to
 *      the corresponding `cli_refresh_tokens.device_name`. When OIDC is
 *      not loaded the registry is empty and this branch no-ops.
 *   3. `null` — the dashboard falls back to the existing
 *      `runOrigin === "remote"` "Distant" badge.
 */

import type { Context } from "hono";
import { getRunnerResolver } from "./runner-resolver.ts";

const RUNNER_NAME_HEADER = "x-appstrate-runner-name";
const RUNNER_KIND_HEADER = "x-appstrate-runner-kind";
const RUNNER_NAME_MAX_LENGTH = 120;
const RUNNER_KIND_MAX_LENGTH = 32;

interface ResolvedRunnerContext {
  name: string | null;
  kind: string | null;
}

function clamp(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export async function resolveRunnerContext(c: Context): Promise<ResolvedRunnerContext> {
  const headerName = clamp(c.req.header(RUNNER_NAME_HEADER), RUNNER_NAME_MAX_LENGTH);
  const headerKindRaw = clamp(c.req.header(RUNNER_KIND_HEADER), RUNNER_KIND_MAX_LENGTH);
  const headerKind = headerKindRaw?.toLowerCase() ?? null;

  // The OIDC strategy stamps the CLI family id here when a Bearer JWT
  // carrying `cli_family_id` resolves successfully — see
  // `apps/api/src/modules/oidc/auth/strategy.ts`.
  const authExtra = c.get("authExtra") as { cliFamilyId?: unknown } | undefined;
  const cliFamilyId =
    authExtra && typeof authExtra.cliFamilyId === "string" ? authExtra.cliFamilyId : null;

  let resolvedName = headerName;
  let resolvedKindFromResolver: string | null = null;

  if (!resolvedName || !headerKind) {
    const resolver = getRunnerResolver();
    if (resolver) {
      const result = await resolver({ cliFamilyId });
      if (result) {
        if (!resolvedName) resolvedName = result.name;
        if (!headerKind && result.kind) resolvedKindFromResolver = result.kind;
      }
    }
  }

  // Kind preference: explicit header wins; otherwise use whatever the
  // resolver returned (`"cli"` for CLI tokens). If neither, leave null —
  // the UI's badge has a generic branch for that case.
  const resolvedKind = headerKind ?? resolvedKindFromResolver;

  return { name: resolvedName, kind: resolvedKind };
}
