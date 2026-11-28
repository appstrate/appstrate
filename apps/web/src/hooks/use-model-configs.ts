// SPDX-License-Identifier: Apache-2.0

/**
 * The organization's model configurations (`/api/model-configs`): a provider family, its
 * endpoint (a gateway's), its models and whether members may connect their own. A write to a
 * configuration changes the models it lists and the connections it accepts: every path is
 * read again.
 */

import type { MutationMeta } from "@tanstack/react-query";
import { $api } from "../api/client";
import type { ModelConfigInfo } from "../lib/model-configs";
import { MODEL_CACHE_PATHS } from "../lib/query-keys";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { useOrgOnlyScope } from "./use-org-scope";

export type { ModelConfigInfo };

/** `models:read`, like the models list. */
export function useModelConfigs() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/model-configs",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

/** `meta`: the creation dialog shows its refusal (`model_config_exists`) itself. */
export function useCreateModelConfig(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("post", "/api/model-configs", { meta, onSuccess: invalidate });
}

/** `meta`: the endpoint form shows its refusal inline; a rename or the switch go through the toast. */
export function useUpdateModelConfig(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("patch", "/api/model-configs/{id}", { meta, onSuccess: invalidate });
}

export function useDeleteModelConfig() {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("delete", "/api/model-configs/{id}", { onSuccess: invalidate });
}
