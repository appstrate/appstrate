// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { z } from "zod";
import { zFilePurposeEnum } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import type { ListFilesFilters } from "../services/files.ts";
import { parseBody } from "./errors.ts";
import { parseListPagination } from "@appstrate/core/list-query";

const listFilesQuerySchema = z
  .object({
    purpose: zFilePurposeEnum.optional(),
    runId: z.string().optional(),
    packageId: z.string().optional(),
    chat_session_id: z.string().optional(),
    context_chat_session_id: z.string().optional(),
    q: z.string().max(200).trim().optional(),
    startingAfter: z.string().optional(),
    // Checked by `parseListPagination` (anything but 1..100 is a 400).
    limit: z.string().optional(),
  })
  .strict();

/**
 * The gallery filters of `GET /api/files` and `GET /api/orgs/{orgId}/files`.
 * Query-param casing follows the wire DTO (CASING_CONVENTIONS.md carve-out 4b):
 * `runId`, `packageId` and the `startingAfter` pagination param are camelCase;
 * `chat_session_id` is a snake_case domain field. Strict: an unknown or
 * misspelled filter is a 400, never a silently widened listing.
 */
export function parseListFilesQuery(c: Context<AppEnv>): ListFilesFilters {
  const parsed = parseBody(listFilesQuerySchema, c.req.query());
  const filters: ListFilesFilters = {};
  if (parsed.purpose) filters.purpose = parsed.purpose;
  if (parsed.runId) filters.runId = parsed.runId;
  if (parsed.packageId) filters.packageId = parsed.packageId;
  if (parsed.chat_session_id) filters.chatSessionId = parsed.chat_session_id;
  if (parsed.context_chat_session_id) {
    filters.contextChatSessionId = parsed.context_chat_session_id;
  }
  if (parsed.q) filters.search = parsed.q;
  if (parsed.startingAfter) filters.startingAfter = parsed.startingAfter;
  filters.limit = parseListPagination(c, { defaultLimit: 20 }).limit;
  return filters;
}
