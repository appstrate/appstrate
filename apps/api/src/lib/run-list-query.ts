// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { GLOBAL_RUN_KINDS, type GlobalRunListFilters } from "../services/state/runs.ts";
import { invalidRequest } from "./errors.ts";
import { parseListLimit } from "@appstrate/core/list-query";
import { parseRunListFilters } from "./run-list-filters.ts";

/** The closed set a run list's `?user=` accepts: `me`, the caller's own runs. */
const USER_FILTERS = ["me"] as const;
/** `?unread=` on a run list: a boolean, so `true` or `false`. */
const UNREAD_FILTERS = ["true", "false"] as const;

/** Every query parameter {@link parseGlobalRunListQuery} reads. */
export const RUN_LIST_QUERY_PARAMETERS = [
  "user",
  "kind",
  "unread",
  "status",
  "q",
  "start_date",
  "end_date",
  "chat_session_id",
  "limit",
  "startingAfter",
] as const;

/**
 * Read a query parameter whose accepted values are a closed set.
 *
 * **An unrecognised value is a 400, never `undefined`.** Every user of this
 * helper is a *filter*, and silently dropping a filter widens the result set:
 * `?kind=inlinee` would return every kind, `?status=succes` every status, to a
 * caller reading the response as narrowed. That is the failure mode worth
 * spending a 400 on — the caller gets a list that looks right and is wrong.
 *
 * **Present-but-empty (`?kind=`) reads as absent.** An empty value is how a
 * form, a URL builder, or a client that always emits its keys spells "no
 * filter"; rejecting it would break those callers without protecting anyone.
 * That is not the silent-widening case: nothing was requested, so nothing is
 * dropped.
 *
 * The `allowed` tuple is also what the OpenAPI operation declares as the
 * parameter's `enum`, so the spec and the runtime check state the same set.
 */
function closedSetQuery<T extends string>(
  c: Context<AppEnv>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw invalidRequest(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return raw as T;
}

/**
 * The query of a run list spanning a space or an organization: the parameters
 * {@link RUN_LIST_QUERY_PARAMETERS} names. `user`, `kind` and `status` are
 * closed sets: an unrecognised value is a 400, not a dropped filter. Keyset-paged:
 * `startingAfter` is the last run id of the previous page; `limit` is 20 when absent, and a
 * value outside its range is a 400 (`parseListLimit`) — a page other than the one asked would
 * read as the list.
 */
export function parseGlobalRunListQuery(
  c: Context<AppEnv>,
): GlobalRunListFilters & { limit: number } {
  const limit = parseListLimit(c, { defaultLimit: 20 });
  const startingAfter = c.req.query("startingAfter") || undefined;
  // `user=me` narrows to the caller's own runs even where `runs:read-all`
  // would have widened the list, and composes with every filter below. An
  // end-user needs no branch of its own: `read-all` is not grantable to them.
  const ownOnly = closedSetQuery(c, "user", USER_FILTERS) === "me";
  const kind = closedSetQuery(c, "kind", GLOBAL_RUN_KINDS);
  // `?unread=true`: only the runs the caller has not read yet (per recipient).
  const unread = closedSetQuery(c, "unread", UNREAD_FILTERS) === "true";
  const { status, search } = parseRunListFilters({
    status: c.req.query("status"),
    q: c.req.query("q"),
  });
  const startDateRaw = c.req.query("start_date");
  const endDateRaw = c.req.query("end_date");
  const chatSessionId = c.req.query("chat_session_id") || undefined;
  const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
  const endDate = endDateRaw ? new Date(endDateRaw) : undefined;
  if (startDate && Number.isNaN(startDate.getTime())) {
    throw invalidRequest("start_date is not a valid ISO date", "start_date");
  }
  if (endDate && Number.isNaN(endDate.getTime())) {
    throw invalidRequest("end_date is not a valid ISO date", "end_date");
  }
  return {
    limit,
    startingAfter,
    ownOnly,
    kind,
    unread,
    status,
    search,
    startDate,
    endDate,
    chatSessionId,
  };
}
