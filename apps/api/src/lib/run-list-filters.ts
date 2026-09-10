// SPDX-License-Identifier: Apache-2.0

import { eq, ilike, or, type SQL } from "drizzle-orm";
import { runs, runStatusValues, type RunStatus } from "@appstrate/db/schema";
import { invalidRequest } from "./errors.ts";

/** The schedule history accepts the same bounded filters as the global run list. */
export function parseRunListFilters(query: { status?: string; q?: string }): {
  status?: RunStatus[];
  search?: string;
} {
  const search = query.q?.trim() || undefined;
  if (search && search.length > 200) throw invalidRequest("q must be 200 characters or fewer", "q");
  const parts = query.status ? query.status.split(",").map((part) => part.trim()) : undefined;
  if (parts?.some((part) => !(runStatusValues as readonly string[]).includes(part))) {
    throw invalidRequest(`status must be one of: ${runStatusValues.join(", ")}`, "status");
  }
  return { status: parts ? ([...new Set(parts)] as RunStatus[]) : undefined, search };
}

/** Match literal user text, never LIKE wildcards supplied by the caller. */
export function runSearchCondition(search: string): SQL {
  const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const matches: SQL[] = [
    ilike(runs.agentName, pattern),
    ilike(runs.agentScope, pattern),
    ilike(runs.error, pattern),
  ];
  const asNumber = Number(search.replace(/^#/, ""));
  if (Number.isInteger(asNumber) && asNumber > 0) matches.push(eq(runs.runNumber, asNumber));
  return or(...matches)!;
}
