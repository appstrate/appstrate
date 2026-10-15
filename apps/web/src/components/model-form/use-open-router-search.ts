// SPDX-License-Identifier: Apache-2.0

/**
 * Debounced OpenRouter model search used inside the model-form modal.
 * Keeps the 300 ms debounce + the gated query enabled together so the
 * combobox host doesn't have to wire two pieces of state.
 *
 * The query stays disabled when the selected provider is not OpenRouter
 * — passing `enabled=false` lets the host skip the network roundtrip on
 * every provider change.
 */

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
