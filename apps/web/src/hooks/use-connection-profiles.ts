// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { apiList } from "../api";
import type { MeConnectionSourceGroup } from "@appstrate/shared-types";

/**
 * Unified user-scope connection list (integration connections), grouped by
 * source package. Backs the `/preferences/connectors` page.
 * Crosses orgs/applications: no header context required.
 *
 * The legacy connection-profile / app-profile hooks that used to live here
 * were removed alongside the profiles feature — integrations now use the
 * flat connections + pins model.
 */
export function useMyConnections() {
  return useQuery({
    queryKey: ["me-connections"],
    queryFn: () => apiList<MeConnectionSourceGroup>("/me/connections"),
  });
}
