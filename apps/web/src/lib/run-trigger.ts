// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type RunTriggerType = "cli" | "schedule" | "api" | "endUser" | "manual";

/** What launched a run, from what the run row records; a run recording nothing is manual. */
export function getRunTriggerType(run: EnrichedRun): RunTriggerType {
  if (run.scheduleId) return "schedule";
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
