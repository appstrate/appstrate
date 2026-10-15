// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

/**
 * "Rechercher des runs…" — one shape for every table, not a list of matched fields.
 * `entity` is the caller's PLURAL label, lowercased on its first letter only so
 * "Serveurs MCP" does not become "serveurs mcp".
 */
export function useSearchPlaceholder(entity: string): string {
  const { t } = useTranslation("common");
  return t("toolbar.searchEntity", {
    entity: entity.charAt(0).toLowerCase() + entity.slice(1),
  });
}
