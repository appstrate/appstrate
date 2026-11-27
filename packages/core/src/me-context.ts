// SPDX-License-Identifier: Apache-2.0

/**
 * The wire shape of `GET /api/me/context`, which the MCP `get_me` tool relays as
 * `{ status, body, spaces? }`. One definition for the tool's `outputSchema` and for the chat that
 * reads it. Objects keep unknown keys, so a field the server adds does not break a reader; the
 * closed enums (`org.role`, `source`, `via`, `can`) reject a value they do not list.
 */

import { z } from "zod";
import { SPACE_ACTS } from "./mcp-spaces.ts";
import { ORG_ROLES } from "./permissions.ts";

/** A capped list: whole or withheld, `total` counts every entry either way. */
const cappedList = <T extends z.ZodType>(item: T) =>
  z.looseObject({ data: z.array(item), truncated: z.boolean(), total: z.int() });

const connection = z.looseObject({
  id: z.string(),
  label: z.string(),
  account_id: z.string(),
  owned_by_actor: z.boolean(),
  needs_reconnection: z.boolean(),
});

const integrationEntry = z.looseObject({
  integration_package_id: z.string(),
  name: z.string(),
  source: z.enum(["own", "shared", "both"]),
  active: z.boolean(),
  via: z.enum(["home", "shared", "system", "organization"]).nullable(),
  connections: z.array(connection),
  version: z.string().optional(),
  needs_reconnection: z.literal(true).optional(),
  default_tools: z.union([z.array(z.string()), z.literal("*")]).optional(),
});

const agentEntry = z.looseObject({
  packageId: z.string(),
  display_name: z.string(),
  description: z.string(),
  takes_input: z.boolean(),
  inactive_required_integrations: z.array(z.string()),
  published: z.boolean(),
  home_writable: z.boolean(),
  source: z.string(),
});

const skillEntry = z.looseObject({
  packageId: z.string(),
  display_name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  published: z.boolean(),
  home_writable: z.boolean(),
  source: z.string(),
});

const recentRun = z.looseObject({
  packageId: z.string(),
  status: z.string(),
  runNumber: z.int().nullable().optional(),
  started_at: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

/** The space-level part of the body comes whole or not at all. */
const SPACE_LEVEL = ["connections", "connectable_integrations", "recent_runs", "agents", "skills"];

/** The body of `GET /api/me/context`. */
export const meContextSchema = z
  .looseObject({
    user: z.looseObject({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    }),
    org: z.looseObject({
      id: z.string(),
      role: z.enum([...ORG_ROLES, "end_user"] as const),
      name: z.string(),
      slug: z.string(),
    }),
    space: z.looseObject({ id: z.string(), name: z.string(), personal: z.boolean() }).optional(),
    connections: z.array(integrationEntry).optional(),
    connectable_integrations: cappedList(z.string()).optional(),
    recent_runs: z.array(recentRun).optional(),
    agents: cappedList(agentEntry).optional(),
    skills: cappedList(skillEntry).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.space === undefined) return;
    for (const key of SPACE_LEVEL) {
      if (!(key in body))
        ctx.addIssue({ code: "custom", path: [key], message: "missing with space" });
    }
  });

/** One space `get_me` names with its acts, in an organization-wide connection. */
const spaceReach = z.looseObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  personal: z.boolean().optional(),
  can: z.array(z.enum(SPACE_ACTS)),
});

/** `get_me`'s answer when the route answered 200: the body and, org-wide, the spaces reached. */
export const getMeResultSchema = z.looseObject({
  status: z.literal(200),
  etag: z.string().optional(),
  body: meContextSchema,
  spaces: z.array(spaceReach).optional(),
});
