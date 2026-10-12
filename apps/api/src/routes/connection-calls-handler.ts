// SPDX-License-Identifier: Apache-2.0

/**
 * The two reads of the credential proxy's call journal, mounted by the routers that own their
 * paths: `GET /api/me/connections/{connectionId}/calls` (the connection's owner, `routes/me.ts`)
 * and `GET /api/integrations/calls` (the space's governor, `routes/integrations.ts`). Same query
 * string, same row shape, JSON or `?format=csv`.
 */

import type { Context } from "hono";
import { z } from "zod";
import type { ListEnvelope } from "@appstrate/shared-types";
import type { AppEnv } from "../types/index.ts";
import { connectionPrincipal } from "../lib/connection-principal.ts";
import { notFound, parseBody } from "../lib/errors.ts";
import { parseListPagination } from "../lib/list-query.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";
import { getSpaceScope } from "../lib/scope.ts";
import {
  connectionCallsCsv,
  listOwnConnectionCalls,
  listSpaceConnectionCalls,
  type ConnectionCallFilters,
  type ConnectionCallPage,
  type ConnectionCallView,
} from "../services/connection-calls.ts";

const JSON_PAGE = { defaultLimit: 50, maxLimit: 200 };
/** A CSV export is one bounded page; its `Link` header continues it. */
const CSV_PAGE = { defaultLimit: 10_000, maxLimit: 10_000 };

// Strict: an unknown or misspelled filter is a 400, never a silently widened journal.
const ownCallsQueryShape = {
  actor_id: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  start_date: z.iso.datetime({ offset: true }).optional(),
  end_date: z.iso.datetime({ offset: true }).optional(),
  format: z.enum(["json", "csv"]).optional(),
  // A row id: a positive integer within the safe range.
  startingAfter: z
    .string()
    .regex(/^[1-9]\d{0,14}$/)
    .optional(),
  // Checked by `parseListPagination`.
  limit: z.string().optional(),
};
const ownCallsQuerySchema = z.object(ownCallsQueryShape).strict();
const spaceCallsQuerySchema = z
  .object({ ...ownCallsQueryShape, connection_id: z.uuid().optional() })
  .strict();

type CallsQuery = z.infer<typeof spaceCallsQuerySchema>;

function readQuery(
  c: Context<AppEnv>,
  query: CallsQuery,
): { filters: ConnectionCallFilters; page: ConnectionCallPage; csv: boolean } {
  const csv = query.format === "csv";
  return {
    filters: {
      connectionId: query.connection_id?.toLowerCase(),
      actorId: query.actor_id,
      runId: query.runId,
      startDate: query.start_date ? new Date(query.start_date) : undefined,
      endDate: query.end_date ? new Date(query.end_date) : undefined,
    },
    page: {
      limit: parseListPagination(c, csv ? CSV_PAGE : JSON_PAGE).limit,
      startingAfter: query.startingAfter ? Number(query.startingAfter) : undefined,
    },
    csv,
  };
}

function send(c: Context<AppEnv>, result: ListEnvelope<ConnectionCallView>, csv: boolean) {
  const lastId = result.data.at(-1)?.id;
  setCursorLinkHeader({
    c,
    hasMore: result.hasMore,
    lastId: lastId === undefined ? undefined : String(lastId),
  });
  if (!csv) return c.json(result);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="connection-calls.csv"');
  return c.body(connectionCallsCsv(result.data));
}

/**
 * `GET /api/me/connections/:connectionId/calls`: every call made with a connection the caller
 * owns. Authorized by ownership inside the credential's binding, as the sibling
 * `/api/me/connections/:connectionId/*` routes are; anything else is a 404.
 */
export async function serveOwnConnectionCalls(c: Context<AppEnv>): Promise<Response> {
  const connectionId = c.req.param("connectionId")!;
  const missing = () => notFound(`Connection '${connectionId}' not found`);
  // The id hits a `uuid` column: a non-UUID would raise PG `22P02` and surface as a 500.
  if (!z.uuid().safeParse(connectionId).success) throw missing();
  const { filters, page, csv } = readQuery(c, parseBody(ownCallsQuerySchema, c.req.query()));
  const result = await listOwnConnectionCalls(
    connectionPrincipal(c),
    connectionId.toLowerCase(),
    filters,
    page,
  );
  if (!result) throw missing();
  return send(c, result, csv);
}

/** `GET /api/integrations/calls`: every call made in the request space, whatever the connection. */
export async function serveSpaceConnectionCalls(c: Context<AppEnv>): Promise<Response> {
  const { filters, page, csv } = readQuery(c, parseBody(spaceCallsQuerySchema, c.req.query()));
  return send(c, await listSpaceConnectionCalls(getSpaceScope(c), filters, page), csv);
}
