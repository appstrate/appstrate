// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { GLOBAL_RUN_KINDS, type GlobalRunListFilters } from "../services/state/runs.ts";
import { invalidRequest, zodIssuesToFieldErrors } from "./errors.ts";
import { parseListLimit } from "@appstrate/core/list-query";
import { parseRunListFilters } from "./run-list-filters.ts";

/**
 * A closed-set filter. An unrecognised value is a 400: dropping it would widen
 * a list the caller reads as narrowed. An empty value (`?kind=`) reads as
 * absent — how a form or a URL builder emitting every key spells "no filter".
 */
const closedSet = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), z.enum(values).optional());

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
  const parsed = runListQuerySchema.safeParse(c.req.query());
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
  };
}
