// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useDiscoverModels } from "../../hooks/use-model-provider-credentials";
import { ApiError } from "../../api/errors";
import type { DiscoverBody, DiscoveryState } from "@/lib/model-discovery";

/**
 * Asking an endpoint what it serves. Discovery persists nothing, so the listing lives here, and
 * only for what it ran against: `key` names the endpoint and key of the current form, and a
 * listing asked under another key is no longer returned.
 */
export function useModelDiscovery(key: string) {
  const discover = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);

  const detect = (body: DiscoverBody) => {
    discover.mutate(
      { body },
      {
        onSuccess: (data) =>
          setDiscovery({
            key,
            outcome: data.outcome,
            models: data.models,
            truncated: data.truncated,
          }),
        onError: (err) =>
          setDiscovery({
            key,
            // The platform's own rate limit; `rate_limited` is the endpoint's.
            outcome: err instanceof ApiError && err.status === 429 ? "throttled" : "request_failed",
            models: [],
            truncated: false,
          }),
      },
    );
  };

  return {
    discovery: discovery?.key === key ? discovery : null,
    detecting: discover.isPending,
    detect,
  };
}
