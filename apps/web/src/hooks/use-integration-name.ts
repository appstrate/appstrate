// SPDX-License-Identifier: Apache-2.0

import { useIntegrationDetail } from "./use-integrations";

/** An integration's display name, for a sentence: its id (`@scope/name`) while unread or unreadable. */
export function useIntegrationName(integrationId: string): string {
  return useIntegrationDetail(integrationId).data?.manifest.display_name ?? integrationId;
}
