// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { searchOf } from "../lib/url-search";

/**
 * A deep link's one-shot parameter (`?agentRunStatus=`, `?connectionMethod=`): read at
 * mount, then dropped from the address so it does not stick to the tab.
 */
export function useConsumedSearchParam(name: string): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const urlValue = new URLSearchParams(location.search).get(name);
  const [value] = useState(urlValue);
  useEffect(() => {
    if (urlValue === null) return;
    const params = new URLSearchParams(location.search);
    params.delete(name);
    void navigate(
      { search: searchOf(params), hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [name, urlValue, location.search, location.hash, location.state, navigate]);
  return value;
}
