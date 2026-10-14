// SPDX-License-Identifier: Apache-2.0

/**
 * The index page of a package type the space runs: agents, skills, MCP
 * servers. One page for the three, so a fix to one (an error state, the
 * keywords the search reads, the actions menu) lands on all of them.
 * Integrations keep their own page: execution tabs, protocol filter, columns.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { LibraryBig, Plus, Upload } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import {
  PACKAGE_WRITE_PERMISSIONS,
  packagePermission,
  spacePackagePermission,
} from "@appstrate/core/permissions";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useAgents, usePackageList } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { useListView } from "../stores/list-view-store";
import { useListParams } from "../lib/list-params";
import { catalogueHref } from "../lib/catalogue-link";
import { packageNewPath } from "../lib/package-paths";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import { agentCardItem, packageCardItem, type CardItem } from "../lib/package-card-item";
import { PageHeader } from "../components/page-header";
import { PackageCollection } from "../components/package-collection";
import { EmptyStateAction } from "../components/page-states";
import { PageActionsMenu } from "../components/page-actions-menu";
import { useModalParam } from "../hooks/use-modal-param";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { usePermissions } from "../hooks/use-permissions";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";

type IndexType = Extract<PackageType, "agent" | "skill" | "mcp-server">;

/** The page's words for its type. */
function presentation(type: IndexType, t: TFunction) {
  if (type === "agent") {
    return {
      title: t("list.tabAgents", { ns: "agents" }),
      empty: t("list.empty", { ns: "agents" }),
      create: t("list.create", { ns: "agents" }),
    };
  }
  const typeLabel = t(`packages.type.${type}`, { ns: "settings" });
  return {
    title: t(`packages.type.${type}s`, { ns: "settings" }),
    empty: t("packages.emptyItems", { ns: "settings", type: typeLabel }),
    create: t("list.createItem", { ns: "agents", type: typeLabel }),
  };
}

export function PackageIndexPage({
  type,
  manualCreation = "editor",
}: {
  type: IndexType;
  /** Where « create manually » goes: the editor, or the import (MCP servers). */
  manualCreation?: "editor" | "import";
}) {
  return type === "agent" ? (
    <AgentIndex />
  ) : (
    <PackageIndex type={type} manualCreation={manualCreation} />
  );
}

/** Agents also carry their unread runs. */
function AgentIndex() {
  const { data: agents, isLoading, error } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const items = agents?.map((agent) => agentCardItem(agent, unreadCounts?.[agent.id]));
  return (
    <PackageIndexBody
      type="agent"
      manualCreation="editor"
      items={items}
      isLoading={isLoading}
      error={error}
    />
  );
}

function PackageIndex({
  type,
  manualCreation,
}: {
  type: Exclude<IndexType, "agent">;
  manualCreation: "editor" | "import";
}) {
  // What works in THIS space; the rest of the org is one action away.
  const { data: rows, isLoading, error } = usePackageList(type);
  const items = rows?.map((row) => packageCardItem(row, type));
  return (
    <PackageIndexBody
      type={type}
      manualCreation={manualCreation}
      items={items}
      isLoading={isLoading}
      error={error}
    />
  );
}

function PackageIndexBody({
  type,
  manualCreation,
  items,
  isLoading,
  error,
}: {
  type: IndexType;
  manualCreation: "editor" | "import";
  items: CardItem[] | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { can } = usePermissions();
  const importParam = useModalParam("import");
  const [view, setView] = useListView(type);
  const list = useListParams(["origin", "activity"]);
  // Creating is a write on the package type, as its route is.
  const canCreate = can(packagePermission(type, "write"));
  // An import may carry any package type, so any authoring grant opens it;
  // the server re-checks the type it finds.
  const canImport = PACKAGE_WRITE_PERMISSIONS.some(can);
  const canActivate = can(spacePackagePermission(type, "activate"));
  const creation = useCreationHandoff(type, canCreate);
  const words = presentation(type, t);

  return (
    <>
      <PageHeader
        title={words.title}
        variant="collection"
        breadcrumbs={[{ label: words.title }]}
        actions={
          canCreate || canImport || canActivate ? (
            <PageActionsMenu>
              {canActivate && (
                <DropdownMenuItem asChild data-page-action="catalogue">
                  <Link to={catalogueHref(type)}>
                    <LibraryBig />
                    {t("catalogue.browse", { ns: "settings" })}
                  </Link>
                </DropdownMenuItem>
              )}
              {canImport && (
                <DropdownMenuItem data-page-action="import" onSelect={() => importParam.open()}>
                  <Upload />
                  {t("nav.import", { ns: "common" })}
                </DropdownMenuItem>
              )}
              {canCreate && (
                <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                  <Plus />
                  {words.create}
                </DropdownMenuItem>
              )}
            </PageActionsMenu>
          ) : undefined
        }
      />
      <PackageCollection
        tableId={`packages-${type}`}
        items={items}
        isLoading={isLoading}
        error={error}
        holds={type}
        entity={words.title}
        emptyMessage={words.empty}
        emptyHint={<SpaceLibraryHint type={type} />}
        emptyIcon={PACKAGE_TYPE_ICON[type]}
        emptyAction={
          canCreate ? <EmptyStateAction label={words.create} onClick={creation.open} /> : undefined
        }
        list={list}
        view={view}
        onViewChange={setView}
      />
      {importParam.value !== null && canImport && (
        <ImportModal onClose={importParam.close} onLeave={importParam.leave} />
      )}
      {creation.isOpen && (
        <CreationHandoffModal
          resource={type}
          onClose={creation.close}
          onManual={() => {
            if (manualCreation === "import") {
              // Handing over from the chooser: one navigation, never two modals.
              importParam.open("1", "create");
              return;
            }
            creation.leave(packageNewPath(type));
          }}
          onChat={creation.openChat}
        />
      )}
    </>
  );
}
