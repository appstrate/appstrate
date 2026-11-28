// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";
import { runDetailPath } from "../lib/package-paths";
import { useReachableSpaceLink } from "./use-can-reach";

type RunPageTarget = Pick<EnrichedRun, "id" | "packageId" | "spaceId">;

/**
 * The run's page, entering its space when it is not the working one: none when the run has no
 * agent left to live under or its page does not open for the reader.
 */
export function useRunPageHref(run: RunPageTarget): string | undefined {
  const linkInSpace = useReachableSpaceLink();
  return (
    (run.packageId && linkInSpace(runDetailPath(run.packageId, run.id), run.spaceId)) || undefined
  );
}
