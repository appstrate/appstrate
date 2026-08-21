// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

/**
 * "Rechercher des runs…" — the verb, then what the table holds.
 *
 * One shape for every table, rather than each box listing the fields it
 * matches. A placeholder is read as "what does this do", not as documentation:
 * "Agent, erreur, #numéro…" answered a question nobody was asking, and it grows
 * every time the endpoint learns to match one more thing. Nothing is lost by
 * dropping the list — typing a number matches the run number whether or not the
 * placeholder said so.
 *
 * The entity comes in as the caller's own PLURAL label ("Runs", "Serveurs
 * MCP"), lowercased on its first letter only, so "Serveurs MCP" does not become
 * "serveurs mcp".
 */
export function useSearchPlaceholder(entity: string): string {
  const { t } = useTranslation("common");
  return t("toolbar.searchEntity", {
    entity: entity.charAt(0).toLowerCase() + entity.slice(1),
  });
}
