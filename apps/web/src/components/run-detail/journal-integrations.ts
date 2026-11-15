// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useIntegrationsById } from "../../hooks/use-integrations";
import { journalIntegrationIds, type ExecutionEntry, type JournalIntegrations } from "../log-utils";

/**
 * The integrations a journal's tool calls reached, read in one request for the whole journal
 * (`GET /api/integrations?id=…`, shared with the other surfaces through the query cache). An
 * integration deleted, not visible here or unreadable without `integrations:read` keeps its id.
 */
export function useJournalIntegrations(entries: readonly ExecutionEntry[]): JournalIntegrations {
  const ids = useMemo(() => journalIntegrationIds(entries), [entries]);
  const { data, isLoading, isPlaceholderData } = useIntegrationsById(ids);
  const reading = isLoading || isPlaceholderData;
  // Stable while the read is: the journal's filtering and scrolling key on it.
  return useMemo(() => {
    const rows = new Map((data ?? []).map((row) => [row.id, row] as const));
    return (integrationId: string) => {
      const row = rows.get(integrationId);
      return {
        name: row?.manifest.display_name ?? integrationId,
        icon: row?.manifest.icon,
        pending: !row && reading,
      };
    };
  }, [data, reading]);
}
