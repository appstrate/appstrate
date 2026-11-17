// SPDX-License-Identifier: Apache-2.0

/** The space an integration's per-space tab acts in, in « Tous les espaces » (`IntegrationSpaceSelector`). */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { $api } from "../../api/client";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { useCurrentOrgId } from "../../hooks/use-org";
import { packageDetailQueryOptions } from "../../hooks/use-packages";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceAction, useSpacesFor } from "../../hooks/use-space-action";

/**
 * `useSpaceAction` among the integration's spaces (`spaceIds`) where `permission` holds. Entering
 * another space reads the integration there first (its detail, kept on that space's key, and its
 * package detail, put back once the switch has dropped the package caches), so the page redrawn
 * in it holds that space's integration without waiting. `entering` while it reads.
 */
export function useIntegrationSpaceAction(
  packageId: string,
  permission: string,
  spaceIds: readonly string[],
) {
  const { t } = useTranslation("common");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const [entering, setEntering] = useState(false);
  return {
    ...useSpaceAction({ permission }, spaceIds, {
      preferWorkingSpace: false,
      prepare: async (spaceId, act) => {
        setEntering(true);
        try {
          const packageDetail = packageDetailQueryOptions(
            "integration",
            { orgId, spaceId },
            packageId,
          );
          const [, pkg] = await Promise.all([
            qc.fetchQuery(
              $api.queryOptions("get", "/api/integrations/{packageId}", {
                params: {
                  path: { packageId },
                  header: { "X-Org-Id": orgId ?? undefined, "X-Space-Id": spaceId },
                },
              }),
            ),
            qc.fetchQuery(packageDetail),
          ]);
          return () => {
            qc.setQueryData(packageDetail.queryKey, pkg);
            act();
          };
        } catch (error) {
          toast.error(t("error.generic"));
          throw error;
        } finally {
          setEntering(false);
        }
      },
    }),
    entering,
  };
}

/**
 * A sentence about the working space: `plain` (« cet espace ») with a space selected; in « Tous
 * les espaces », where the selector above names it, `named` with that space as `{{space}}`.
 */
export function useWorkingSpaceWording() {
  const { t } = useTranslation("settings");
  const { on } = useOverviewMode();
  const space = useSpaceLabelOf()(useCurrentSpaceId());
  return (plain: string, named: string, options: Record<string, unknown> = {}): string =>
    on && space ? t(named, { ...options, space }) : t(plain, options);
}

/**
 * Whether the integration's configuration opens: the working space's grant with a space selected;
 * in « Tous les espaces », some space of `spaceIds` (where it is active) granting it.
 */
export function useConfiguresIntegration(spaceIds: readonly string[]): boolean {
  const { can } = usePermissions();
  const { on, offered } = useSpacesFor({ permission: "integrations:configure" }, spaceIds);
  return on ? offered : can("integrations:configure");
}
