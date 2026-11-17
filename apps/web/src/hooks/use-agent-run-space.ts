// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AgentDetail } from "@appstrate/shared-types";
import { packageDetailQueryOptions, type Versioned } from "./use-packages";
import { useSpaceAction } from "./use-space-action";
import { useCurrentOrgId } from "./use-org";
import { spaceStore } from "../stores/space-store";

const NO_SPACES: readonly string[] = [];

/**
 * An act on an agent where `permission` holds: `useSpaceAction` among `spaceIds`, the spaces the
 * agent is active in (in « Tous les espaces », none offers nothing). Entering another space reads
 * the agent's detail there first, from that space; `enteredDetail()`, called by the act once in
 * the space, puts it back on that space's key (the switch drops the package caches) and returns
 * it, so the screen redrawn after the switch and the dialog the act opens hold that space's agent
 * without waiting for it. The read lives only while its act runs. `entering` while it reads.
 */
export function useAgentSpaceAction(
  packageId: string,
  permission: string,
  spaceIds: readonly string[] = NO_SPACES,
  { preferWorkingSpace }: { preferWorkingSpace?: boolean } = {},
) {
  const { t } = useTranslation("common");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const read = useRef<{ spaceId: string; detail: Versioned<AgentDetail> } | null>(null);
  const [entering, setEntering] = useState(false);
  const optionsIn = (spaceId: string) =>
    packageDetailQueryOptions("agent", { orgId, spaceId }, packageId);

  const action = useSpaceAction({ permission }, spaceIds, {
    preferWorkingSpace,
    prepare: async (spaceId, act) => {
      setEntering(true);
      try {
        const detail = await qc.fetchQuery<Versioned<AgentDetail>>(optionsIn(spaceId));
        return () => {
          read.current = { spaceId, detail };
          try {
            act();
          } finally {
            read.current = null;
          }
        };
      } catch (error) {
        toast.error(t("error.generic"));
        throw error;
      } finally {
        setEntering(false);
      }
    },
  });

  const enteredDetail = (): Versioned<AgentDetail> | undefined => {
    const prepared = read.current;
    if (!prepared || prepared.spaceId !== spaceStore.getState().id) return undefined;
    qc.setQueryData(optionsIn(prepared.spaceId).queryKey, prepared.detail);
    return prepared.detail;
  };

  return { ...action, entering, enteredDetail };
}
