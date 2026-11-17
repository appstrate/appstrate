// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import type { DataColumn } from "../components/data-table";
import { PackageIcon } from "../components/package-icon";
import { usePackageSpaceColumn } from "../components/space-column";
import {
  useCatalogueOriginColumn,
  useCatalogueSourceColumn,
} from "../components/catalogue-columns";
import { useOrg } from "../hooks/use-org";
import { packageCardItem } from "../lib/package-card-item";

/**
 * One comparable integration fact per column. `connectionCount` is the caller's own connections
 * of an integration in a row's spaces (`useConnectionCounts`); `undefined` while unknown, when the
 * cell stays empty. An integration that binds no connection (`authenticated: false`) has no count
 * at all, drawn « — » like every other fact that does not apply. `spanning`: an index across
 * spaces, each row naming its spaces.
 */
export function useIntegrationListColumns(
  connectionCount: ((sourceId: string, spaceIds: readonly string[]) => number) | undefined,
  spanning: boolean,
): DataColumn<IntegrationIndexItem>[] {
  const { t } = useTranslation("settings");
  const spaceColumn = usePackageSpaceColumn<IntegrationIndexItem>(spanning, (integration) =>
    packageCardItem(integration, "integration"),
  );
  const origin = useCatalogueOriginColumn<IntegrationIndexItem>(useOrg().currentOrg?.name ?? "");
  const source = useCatalogueSourceColumn<IntegrationIndexItem>(
    (integration) => integration.source_kind,
  );

  return [
    {
      id: "name",
      header: t("integrations.col.name"),
      width: 132,
      elastic: true,
      cell: (integration) => (
        <div className="flex min-w-0 items-center gap-2">
          <PackageIcon type="integration" icon={integration.icon} size="sm" />
          <span className="truncate font-medium">{integration.name}</span>
        </div>
      ),
    },
    ...spaceColumn,
    origin,
    source,
    {
      id: "connections",
      header: t("integrations.col.connections"),
      width: 112,
      align: "end",
      cell: (integration) => {
        if (!integration.authenticated) {
          return (
            <span className="text-muted-foreground" title={t("integrations.connectionNotRequired")}>
              <span aria-hidden>—</span>
              <span className="sr-only">{t("integrations.connectionNotRequired")}</span>
            </span>
          );
        }
        if (!connectionCount) return null;
        const count = connectionCount(integration.id, integration.space_ids);
        return (
          <span className={count ? "tabular-nums" : "text-muted-foreground tabular-nums"}>
            {count}
          </span>
        );
      },
    },
    {
      id: "version",
      header: t("integrations.col.version"),
      width: 88,
      cell: (integration) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {integration.version ?? "—"}
        </span>
      ),
    },
  ];
}
