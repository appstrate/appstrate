// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationManifestView } from "../../hooks/use-integrations";
import { summarizeScopes } from "./connection-scope-fit";

/** A grant in one line, its raw scopes on hover; nothing for an empty grant. */
export function ScopeSummaryText({
  manifest,
  authKey,
  scopes,
  className,
}: {
  manifest: IntegrationManifestView;
  authKey: string;
  scopes: string[];
  className: string;
}) {
  const { t } = useTranslation("settings");
  if (scopes.length === 0) return null;
  return (
    <span className={className} title={scopes.join(" ")}>
      {summarizeScopes(manifest, authKey, scopes) ?? t("integration.connection.defaultPermissions")}
    </span>
  );
}
