// SPDX-License-Identifier: Apache-2.0

/** Debounced OpenRouter search; `enabled=false` (other provider) skips the network roundtrip. */

import { useCallback, useState } from "react";
import { useDebouncedValue } from "../../hooks/use-debounced-value";
import { useOpenRouterModels } from "../../hooks/use-models";

export function useOpenRouterSearch(enabled: boolean) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search);
  // An emptied box asks at once: the abandoned needle must not answer once
  // more into the list the host just reset.
  const needle = search === "" ? "" : debounced;

  const query = useOpenRouterModels(enabled ? needle : undefined);

  const reset = useCallback(() => setSearch(""), []);

  return {
    search,
    setSearch,
    reset,
    models: query.data ?? [],
    isLoading: query.isLoading,
  };
}
