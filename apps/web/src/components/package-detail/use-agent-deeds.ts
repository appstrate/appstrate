// SPDX-License-Identifier: Apache-2.0

/** The agent page's Actions deeds whose space is not the run's (`SpaceDeed`). */

import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentDetail } from "@appstrate/shared-types";
import { $api } from "../../api/client";
import { usePermissions } from "../../hooks/use-permissions";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpaceAction, useSpacesFor } from "../../hooks/use-space-action";
import { spaceLabel } from "../../lib/space-label";
import { splitPackageRef } from "../../lib/package-paths";
import { deedInSpaces, type SpaceDeed } from "./space-deed";

const NO_SPACES: readonly string[] = [];

/**
 * « Supprimer les runs », which deletes every run of the agent in one space: the route asks
 * `runs:read-all` on top of `runs:delete` there. With a working space, offered once the agent ran
 * there; in « Tous les espaces », among the spaces granting both where the agent has a run, each
 * asked on its own route. `pick` receives the space.
 */
export function useClearRunsDeed(
  packageId: string,
  detail: Pick<AgentDetail, "last_run" | "running_runs"> | undefined,
  pick: (spaceId: string) => void,
): SpaceDeed {
  const { t } = useTranslation("common");
  const { on } = useOverviewMode();
  const { can } = usePermissions();
  const orgId = useCurrentOrgId();
  const workingSpaceId = useCurrentSpaceId();
  const deleters = useSpacesFor({ permission: "runs:delete" }).eligible;
  const readers = useSpacesFor({ permission: "runs:read-all" }).eligible;
  const candidates = deleters.filter((space) => readers.some((r) => r.id === space.id));
  const probes = useQueries({
    queries: candidates.map((space) =>
      $api.queryOptions("get", "/api/agents/{scope}/{name}/runs", {
        params: {
          path: splitPackageRef(packageId),
          query: { limit: 1 },
          header: { "X-Org-Id": orgId ?? undefined, "X-Space-Id": space.id },
        },
      }),
    ),
  });

  if (!on) {
    return {
      offered: can("runs:delete") && can("runs:read-all") && !!detail?.last_run && !!workingSpaceId,
      disabled: (detail?.running_runs ?? 0) > 0,
      onSelect: () => workingSpaceId && pick(workingSpaceId),
    };
  }
  const withRuns = candidates.filter((_, i) => (probes[i]?.data?.data.length ?? 0) > 0);
  return deedInSpaces(
    withRuns,
    {
      menu: t("spaceChoice.clearRuns"),
      one: (space) => t("spaceChoice.clearRunsIn", { space: spaceLabel(space, t) }),
    },
    pick,
  );
}

/**
 * « Télécharger le bundle »: the export answers in a space where the agent is active, and the
 * bundle is the same from any of them. With a working space, there while it runs there; in
 * « Tous les espaces », from the working space when it is one of them, else from the first the
 * reader reads agents in, entered without asking.
 */
export function useBundleDeed(
  detail: Pick<AgentDetail, "active" | "space_ids"> | undefined,
  download: (() => void) | undefined,
): SpaceDeed {
  const { on } = useOverviewMode();
  const workingSpaceId = useCurrentSpaceId();
  const readers = useSpacesFor(
    { permission: "agents:read" },
    detail?.space_ids ?? NO_SPACES,
  ).eligible;
  const target = (readers.find((space) => space.id === workingSpaceId) ?? readers[0])?.id;
  const action = useSpaceAction(
    { permission: "agents:read" },
    on ? (target ? [target] : NO_SPACES) : undefined,
  );
  if (!download) return { offered: false };
  return {
    offered: action.offered && (on || detail?.active === true),
    onSelect: () => action.run(download),
  };
}
