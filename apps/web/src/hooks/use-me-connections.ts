// SPDX-License-Identifier: Apache-2.0

/** User-scope connection reads and writes: owner-only `/api/me/connections/*` routes, which need no org/space context. */

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client } from "../api/client";
import { connectionCountBySource } from "../lib/connection-count";
import { useCurrentSpaceId } from "./use-current-space";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useCurrentOrgId } from "./use-org";
import { invalidateSchedules } from "./use-schedules";

/** The caller's connections across every org/space, grouped by source package (no header context). */
export function useMyConnections() {
  return $api.useQuery("get", "/api/me/connections", {}, { select: (e) => e.data });
}

/**
 * The caller's own connections per integration package id, in the current org and space.
 * `undefined` until the account list answers (or when it fails): a caller must not read that as 0.
 */
export function useConnectionCounts(): Map<string, number> | undefined {
  const { data: groups } = useMyConnections();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return useMemo(
    () => (groups ? connectionCountBySource(groups, { orgId, spaceId }) : undefined),
    [groups, orgId, spaceId],
  );
}

/** Fetches only while `connectionId` is set, i.e. while the confirmation is open. */
export function useConnectionDeleteImpact(connectionId: string | undefined) {
  return $api.useQuery(
    "get",
    "/api/me/connections/{connectionId}/delete-impact",
    { params: { path: { connectionId: connectionId ?? "" } } },
    // Never from cache: the user confirms on what this says.
    { gcTime: 0, enabled: !!connectionId },
  );
}

/** Destructive delete (row + cascades): the only deleting endpoint, under `/me/*` so it is never surfaced from an agent context. */
export function useDisconnectIntegrationConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { params: { path: { connectionId: string } } }) => {
      await client.DELETE("/api/me/connections/{connectionId}", vars);
    },
    onSuccess: () => {
      // The caller's own schedule overrides drop the connection; a colleague's schedule
      // naming it is disabled, its overrides kept.
      invalidateSchedules(qc);
      // The connection list, the agent page's reuse hints and accessible-connection lists.
      void invalidateIntegrationQueries(qc);
    },
  });
}

/** Rename the caller's own connection from the user-scope page. */
export function useRenameMeConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      body,
    }: {
      connectionId: string;
      body: { label: string };
    }) => {
      const { data } = await client.PATCH("/api/me/connections/{connectionId}", {
        params: { path: { connectionId } },
        body,
      });
      return data;
    },
    onSuccess: () => {
      // A label shows on every picker and readiness view, not just the connection list.
      return invalidateIntegrationQueries(qc);
    },
  });
}
