// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import type { InSpaces } from "../lib/across-spaces";
import type { DataColumn } from "../components/data-table";
import { PackageIcon } from "../components/package-icon";
import { PackageSharedFrom } from "../components/package-spaces";
import { usePackageSpaceColumn } from "../components/space-column";
import {
  useCatalogueOriginColumn,
  useCatalogueSourceColumn,
} from "../components/catalogue-columns";
import { useOrg } from "../hooks/use-org";

type IntegrationRow = InSpaces<IntegrationIndexItem>;

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
): DataColumn<IntegrationRow>[] {
  const { t } = useTranslation("settings");
  const spaceColumn = usePackageSpaceColumn<IntegrationRow>(spanning, (integration) => ({
    homeSpaceId: integration.home_space_id,
    spaceIds: integration.spaceIds,
    system: integration.source === "system",
  }));
  const origin = useCatalogueOriginColumn<IntegrationRow>(useOrg().currentOrg?.name ?? "");
  const source = useCatalogueSourceColumn<IntegrationRow>((integration) => integration.source_kind);

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
          {!spanning && (
            <PackageSharedFrom
              homeSpaceId={integration.home_space_id}
              system={integration.source === "system"}
            />
          )}
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
        const count = connectionCount(integration.id, integration.spaceIds);
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
