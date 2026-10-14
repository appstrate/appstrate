// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type RunTriggerType = "chat" | "cli" | "mcp" | "schedule" | "api" | "endUser" | "manual";

/**
 * Return only a provenance supported by the persisted run. Older runs do not
 * carry a dedicated launch source, so the fallback is deliberately manual
 * rather than guessing from the infrastructure runner.
 */
export function getRunTriggerType(run: EnrichedRun): RunTriggerType {
  if (run.scheduleId) return "schedule";

  const metadata = run.metadata as Record<string, unknown> | null;
  const recordedSource = metadata?.trigger_source ?? metadata?.launch_source;
  if (recordedSource === "chat") return "chat";
  if (recordedSource === "mcp") return "mcp";

  if (run.runner_kind === "cli") return "cli";
  if (run.apiKeyId || run.api_key_name) return "api";
  if (run.endUserId || run.end_user_name) return "endUser";
  return "manual";
}

export function getRunTriggerActor(run: EnrichedRun): string | null {
  if (run.end_user_name) return run.end_user_name;
  if (run.user_name) return run.user_name;
  if (run.api_key_name) return run.api_key_name;
  return null;
}
