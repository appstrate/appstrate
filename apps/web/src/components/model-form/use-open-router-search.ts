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

import { useEffect, useState } from "react";
import { useOpenRouterModels } from "../../hooks/use-models";

export function useOpenRouterSearch(enabled: boolean) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useOpenRouterModels(enabled ? debounced : undefined);

  return {
    search,
    setSearch,
    models: query.data ?? [],
    isLoading: query.isLoading,
  };
}
