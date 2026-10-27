// SPDX-License-Identifier: Apache-2.0

import { assignableSpaces } from "../lib/space-assignments";
import { useSpaceRoleOptions } from "./use-roles";
import { useSpaces } from "./use-spaces";

/**
 * The spaces and space roles a form can assign, with the loading / error / retry
 * state of both queries — what `SpaceAssignmentsField` takes. `enabled` gates
 * both queries for forms that only need the catalog in some modes.
 */
export function useAssignmentCatalog(enabled = true) {
  const spacesQuery = useSpaces(enabled);
  const rolesQuery = useSpaceRoleOptions(undefined, enabled);
  return {
    spaces: assignableSpaces(spacesQuery.data ?? []),
    roleOptions: rolesQuery.options,
    loading: spacesQuery.isLoading || rolesQuery.isLoading,
    error: spacesQuery.error || rolesQuery.error,
    retry: () => {
      void spacesQuery.refetch();
      void rolesQuery.refetch();
    },
  };
}
