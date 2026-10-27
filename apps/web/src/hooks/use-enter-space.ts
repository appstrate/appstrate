// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { orgStore } from "../stores/org-store";
import { spaceStore } from "../stores/space-store";
import { useOrg } from "./use-org";
import { useSpaceSwitcher } from "./use-current-space";

/**
 * Applies an organization and one of its spaces, whole. In another organization the
 * space is remembered there first, so the space resolver enters it rather than the
 * default. Answers whether the organization changed: the current page may then name
 * a resource of the previous one.
 */
export function useEnterSpace(): (orgId: string, spaceId: string) => boolean {
  const { switchOrg } = useOrg();
  const { switchSpace } = useSpaceSwitcher();
  return useCallback(
    (orgId, spaceId) => {
      if (orgId === orgStore.getState().id) {
        switchSpace(spaceId);
        return false;
      }
      spaceStore.getState().remember(orgId, spaceId);
      switchOrg(orgId);
      return true;
    },
    [switchOrg, switchSpace],
  );
}
