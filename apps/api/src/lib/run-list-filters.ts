// SPDX-License-Identifier: Apache-2.0

import { eq, ilike, or, type SQL } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { runStatusValues, type RunStatus } from "@appstrate/core/run-status";
import { invalidRequest } from "./errors.ts";
import { likeContains } from "./like-pattern.ts";

/** `runs.run_number` is an int4: a larger number names no run, and binding it overflows. */
const MAX_RUN_NUMBER = 2_147_483_647;

/**
 * The `status` and `q` filters every run list accepts. `status` is one member
 * of the closed set or several separated by commas; an unknown member is a 400
 * for the whole list, never dropped, because dropping one widens an answer the
 * caller reads as narrowed. A repeated member collapses.
 */
export function parseRunListFilters(query: { status?: string; q?: string }): {
  status?: RunStatus[];
  search?: string;
} {
  // Bounded because it reaches an unindexed substring match.
  const search = query.q?.trim() || undefined;
  if (search && search.length > 200) throw invalidRequest("q must be 200 characters or fewer", "q");
  const parts = query.status ? query.status.split(",").map((part) => part.trim()) : undefined;
  if (parts?.some((part) => !(runStatusValues as readonly string[]).includes(part))) {
    throw invalidRequest(`status must be one of: ${runStatusValues.join(", ")}`, "status");
  }
  return { status: parts ? ([...new Set(parts)] as RunStatus[]) : undefined, search };
}

/**
 * Literal user text against the agent a run executed and the error it ended on;
 * a query of digits, optionally `#`-prefixed, also matches the run number.
 */
export function runSearchCondition(search: string): SQL {
  const pattern = likeContains(search);
  const matches: SQL[] = [
    ilike(runs.agentName, pattern),
    ilike(runs.agentScope, pattern),
    ilike(runs.error, pattern),
  ];
  const digits = /^#?(\d+)$/.exec(search)?.[1];
  const runNumber = digits ? Number(digits) : 0;
  if (runNumber > 0 && runNumber <= MAX_RUN_NUMBER) matches.push(eq(runs.runNumber, runNumber));
  return or(...matches)!;
}
