// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { z } from "zod";
import { eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { runStatusValues, type RunStatus } from "@appstrate/core/run-status";
import { parseListLimit } from "@appstrate/core/list-query";
import type { AppEnv } from "../types/index.ts";
import { invalidRequest } from "./errors.ts";
import { closedSet, packageIdFilter, parseStrictQuery } from "./list-query.ts";
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
  if (query.q && query.q.length > 200) {
    throw invalidRequest("q must be 200 characters or fewer", "q");
  }
  const search = query.q?.trim() || undefined;
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

/** The conditions of `parseRunListFilters`' result; an absent filter adds none. */
export function runListConditions(filters: { status?: RunStatus[]; search?: string }): SQL[] {
  const conditions: SQL[] = [];
  // An empty list would be `IN ()`, SQL for "nothing", where the caller meant no filter.
  if (filters.status?.length) conditions.push(inArray(runs.status, filters.status));
  if (filters.search) conditions.push(runSearchCondition(filters.search));
  return conditions;
}

/**
 * The closed set `?kind=` accepts, as a value — the route validates the query
 * parameter against it, so the tuple and the type cannot drift.
 */
const GLOBAL_RUN_KINDS = ["all", "package", "inline"] as const;

/** `?space_kind=`: narrows the caller's reach to team spaces or to personal ones. */
const SPACE_KINDS = ["team", "personal"] as const;
type SpaceKind = (typeof SPACE_KINDS)[number];
type GlobalRunKind = (typeof GLOBAL_RUN_KINDS)[number];

/** The filters `GET /api/runs` and `GET /api/orgs/{orgId}/runs` share. */
export interface GlobalRunListFilters {
  limit?: number;
  startingAfter?: string;
  kind?: GlobalRunKind;
  /**
   * Any of these statuses — "everything that broke" is `["failed", "timeout"]`.
   * `RunStatus`, not `string`: the route refuses an unknown value with a 400,
   * and the narrow type keeps a caller from turning a typo into no filter.
   */
  status?: RunStatus[];
  startDate?: Date;
  endDate?: Date;
  chatSessionId?: string;
  /** Only the runs of this package; one the grants do not reach yields no row. */
  packageId?: string;
  /**
   * Free text: the agent a run executed (its scope and name, as stamped on the
   * run) and the error it ended on; digits also match the run number
   * (`runSearchCondition`). A substring match, unindexed.
   */
  search?: string;
  /** Only the runs the actor has not read (`unreadRunCondition`). */
  unread?: boolean;
  /** `?user=me`: the actor's own runs in every space, even where they read all. */
  ownOnly?: boolean;
  /** Only the runs of team spaces or of personal ones (a space with an owner); narrows the reach, never widens it. */
  spaceKind?: SpaceKind;
}

const runListQuerySchema = z
  .object({
    user: closedSet(["me"]),
    kind: closedSet(GLOBAL_RUN_KINDS),
    unread: closedSet(["true", "false"]),
    // Checked by `parseRunListFilters`.
    status: z.string().optional(),
    q: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    chat_session_id: z.string().optional(),
    space_kind: closedSet(SPACE_KINDS),
    packageId: packageIdFilter,
    // Checked by `parseListLimit` (anything but 1..100 is a 400).
    limit: z.string().optional(),
    startingAfter: z.string().optional(),
  })
  .strict();

/** `start_date` / `end_date`: an ISO date, a 400 otherwise. */
function parseDate(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw invalidRequest(`${name} is not a valid ISO date`, name);
  return date;
}

/**
 * The query of `GET /api/runs` and `GET /api/orgs/{orgId}/runs`. Strict: an
 * unknown parameter is a 400, as is a value outside a closed set. Keyset-paged:
 * `startingAfter` is the last run id of the previous page; `limit` is 20 when
 * absent.
 */
export function parseGlobalRunListQuery(
  c: Context<AppEnv>,
): GlobalRunListFilters & { limit: number } {
  const query = parseStrictQuery(c, runListQuerySchema);
  const { status, search } = parseRunListFilters({ status: query.status, q: query.q });
  return {
    limit: parseListLimit(c, { defaultLimit: 20 }),
    startingAfter: query.startingAfter || undefined,
    // `user=me` narrows to the caller's own runs even where `runs:read-all`
    // would have widened the list. An end-user needs no branch of its own:
    // `read-all` is not grantable to them.
    ownOnly: query.user === "me",
    kind: query.kind,
    unread: query.unread === "true",
    status,
    search,
    startDate: parseDate(query.start_date, "start_date"),
    endDate: parseDate(query.end_date, "end_date"),
    chatSessionId: query.chat_session_id || undefined,
    packageId: query.packageId,
    spaceKind: query.space_kind,
  };
}
