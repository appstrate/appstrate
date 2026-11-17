// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { z } from "zod";
import { eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { runStatusValues, type RunStatus } from "@appstrate/core/run-status";
import { parseListLimit } from "@appstrate/core/list-query";
import { scopedNameRegex } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import { GLOBAL_RUN_KINDS, type GlobalRunListFilters } from "../services/state/runs.ts";
import { invalidRequest, zodIssuesToFieldErrors } from "./errors.ts";
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
 * A closed-set filter. An unrecognised value is a 400: dropping it would widen
 * a list the caller reads as narrowed. An empty value (`?kind=`) reads as
 * absent — how a form or a URL builder emitting every key spells "no filter".
 */
const closedSet = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), z.enum(values).optional());

// Built on first use: `services/state/runs.ts` imports this module, so `GLOBAL_RUN_KINDS` is not
// initialised yet while it loads.
const runListQuerySchema = () =>
  z
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
      packageId: packageIdFilter,
      // Checked by `parseListLimit` (anything but 1..100 is a 400).
      limit: z.string().optional(),
      startingAfter: z.string().optional(),
    })
    .strict();

/**
 * The `packageId` filter of a list (runs, schedules): one package id. An empty
 * value reads as absent, as on the closed sets.
 */
export const packageIdFilter = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(scopedNameRegex, { error: "packageId must be a package id (@scope/name)" })
    .optional(),
);

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
  const parsed = runListQuerySchema().safeParse(c.req.query());
  if (!parsed.success) {
    // One `invalid_request` naming the parameter (`param`), as the run lists answer.
    const [issue] = zodIssuesToFieldErrors(parsed.error.issues);
    throw invalidRequest(issue!.message, issue!.field);
  }
  const query = parsed.data;
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
  };
}
