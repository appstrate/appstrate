// SPDX-License-Identifier: Apache-2.0

/**
 * Who reaches which space, across the organisation.
 *
 * A member object does not carry its spaces, so the answer is one request per
 * space. Only an owner or admin can ask it, being admin in every space, and
 * only they are offered the surfaces that need it. A `spaces` field on the
 * member would replace the loop.
 *
 * One hook for the Users table's column and for a person's detail, so opening
 * the detail costs nothing: the queries are already in the cache.
 */
import { useQueries } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { useSpaces } from "./use-spaces";

type SpaceMember = components["schemas"]["SpaceMemberObject"];
type Space = components["schemas"]["SpaceObject"];

export interface SpaceMembership {
  space: Space;
  member: SpaceMember;
}

export function useSpaceMembershipsByUser(enabled: boolean) {
  const scope = useOrgOnlyScope();
  const { data: spaces } = useSpaces(enabled);
  const queries = useQueries({
    queries: (enabled ? (spaces ?? []) : []).map((space) => ({
      ...$api.queryOptions("get", "/api/spaces/{id}/members", {
        params: { path: { id: space.id }, header: scope.header },
      }),
      enabled: scope.enabled,
      select: (envelope: { data: SpaceMember[] }) => ({ space, members: envelope.data }),
    })),
  });

  const byUser = new Map<string, SpaceMembership[]>();
  for (const query of queries) {
    if (!query.data) continue;
    for (const member of query.data.members) {
      byUser.set(member.userId, [
        ...(byUser.get(member.userId) ?? []),
        { space: query.data.space, member },
      ]);
    }
  }
  return { byUser, isLoading: queries.some((query) => query.isLoading) };
}
