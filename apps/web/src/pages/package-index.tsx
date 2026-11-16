// SPDX-License-Identifier: Apache-2.0

/**
 * The index page of a package type the space runs: agents, skills, MCP
 * servers. One page for the three, so a fix to one (an error state, the
 * keywords the search reads, the actions menu) lands on all of them.
 * Integrations keep their own page: execution tabs, protocol filter, columns.
 *
 * In « Vue d'ensemble » it lists every space the reader reaches, one row per
 * placement naming its space. A row runs in its own space; creating, importing
 * and browsing the catalogue ask which space (`useSpaceAction`).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { LibraryBig, Plus, Upload } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { packagePermission, spacePackagePermission } from "@appstrate/core/permissions";
import { useAgents, usePackageList } from "../hooks/use-packages";
import { useListParams } from "../lib/list-params";
import { catalogueHref } from "../lib/catalogue-link";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import { agentCardItem, packageCardItem, type CardItem } from "../lib/package-card-item";
import { PageHeader } from "../components/page-header";
import { PackageCollection } from "../components/package-collection";
import { usePackageColumns } from "../components/package-columns";
import { EmptyStateAction } from "../components/page-states";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { MenuAction } from "../lib/menu-action";
import { useListView } from "../stores/list-view-store";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { usePermissions } from "../hooks/use-permissions";
import { CreatePackageModal } from "../components/create-package-modal";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useSpaceAction } from "../hooks/use-space-action";

type IndexType = Extract<PackageType, "agent" | "skill" | "mcp-server">;

/** The page's words for its type. */
function presentation(type: IndexType, t: TFunction) {
  if (type === "agent") {
    return {
      title: t("common:nav.agents"),
      empty: t("list.empty", { ns: "agents" }),
      emptyAcross: t("list.emptyAcross", { ns: "agents" }),
      create: t("list.create", { ns: "agents" }),
    };
  }
  const typeLabel = t(`packages.type.${type}`, { ns: "settings" });
  return {
    title: t(`packages.type.${type}s`, { ns: "settings" }),
    empty: t("packages.emptyItems", { ns: "settings", type: typeLabel }),
    emptyAcross: t("packages.emptyItemsAcross", { ns: "settings", type: typeLabel }),
    create: t("list.createItem", { ns: "agents", type: typeLabel }),
  };
}

export function PackageIndexPage({ type }: { type: IndexType }) {
  return type === "agent" ? <AgentIndex /> : <PackageIndex type={type} />;
}

/** Agents also carry their unread runs. */
function AgentIndex() {
  const { on: spanning } = useOverviewMode();
  const { data: agents, isLoading, error } = useAgents(spanning);
  const items = agents?.map((agent) => agentCardItem(agent));
  return (
    <PackageIndexBody
      type="agent"
      spanning={spanning}
      items={items}
      isLoading={isLoading}
      error={error}
    />
  );
}

function PackageIndex({ type }: { type: Exclude<IndexType, "agent"> }) {
  const { on: spanning } = useOverviewMode();
  // What works in THIS space (or, spanning, in each); the rest of the org is one action away.
  const { data: rows, isLoading, error } = usePackageList(type, spanning);
  const items = rows?.map((row) => packageCardItem(row, type));
  return (
    <PackageIndexBody
      type={type}
      spanning={spanning}
      items={items}
      isLoading={isLoading}
      error={error}
    />
  );
}

/** Agents are the org's own work: where each came from is a detail, hidden until asked for. */
const AGENT_HIDDEN_COLUMNS = ["origin"];

function PackageIndexBody({
  type,
  spanning,
  items,
  isLoading,
  error,
}: {
  type: IndexType;
  spanning: boolean;
  items: CardItem[] | undefined;
  isLoading: boolean;
  error: Error | null;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { can } = usePermissions();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState<{ integrationId: string | null } | null>(null);
  const list = useListParams(["origin", "activity"]);
  const [view, setView] = useListView(type);
  const { columns, menu } = useColumnVisibility(
    `packages-${type}`,
    usePackageColumns(type, spanning),
    type === "agent" ? AGENT_HIDDEN_COLUMNS : undefined,
  );
  // Creating — by hand, with the chat or by import — is a write on the package
  // type, as its routes are. The import names the type, so the server refuses
  // an archive of another one. Offered where a space grants it; the dialogs open
  // in the working space, which the action entered when it asked for one.
  const write = packagePermission(type, "write");
  const create = useSpaceAction({ permission: write });
  const browse = useSpaceAction({ permission: spacePackagePermission(type, "activate") });
  const canCreate = can(write);
  const creation = useCreationHandoff(type, canCreate);
  // An id that resolves to nothing (typo, out of reach) is not offered: the draft stays plain.
  const integrationDetail = useIntegrationDetail(
    creation.isOpen ? (creation.integrationId ?? undefined) : undefined,
  ).data;
  const integration =
    integrationDetail && creation.integrationId
      ? {
          id: creation.integrationId,
          name: integrationDetail.manifest.display_name ?? creation.integrationId,
        }
      : undefined;
  const words = presentation(type, t);
  const createAction: MenuAction = {
    id: "create",
    label: words.create,
    icon: Plus,
    onSelect: () => create.run(creation.open),
    hidden: !create.offered,
  };

  return (
    <>
      <PageHeader
        title={words.title}
        variant="collection"
        breadcrumbs={[{ label: words.title }]}
        actions={
          create.offered || browse.offered ? (
            <PageActionsMenu
              actions={[
                {
                  id: "catalogue",
                  label: t("catalogue.browse", { ns: "settings" }),
                  icon: LibraryBig,
                  ...browse.link(catalogueHref(type)),
                  hidden: !browse.offered,
                },
                {
                  id: "import",
                  label: t("nav.import", { ns: "common" }),
                  icon: Upload,
                  onSelect: () => create.run(() => setImporting(true)),
                  hidden: !create.offered,
                },
                createAction,
              ]}
            />
          ) : undefined
        }
      />
      <PackageCollection
        columns={columns}
        columnMenu={menu}
        tableId={`packages-${type}`}
        items={items}
        isLoading={isLoading}
        error={error}
        holds={type}
        entity={words.title}
        emptyMessage={spanning ? words.emptyAcross : words.empty}
        emptyHint={spanning ? undefined : <SpaceLibraryHint type={type} />}
        spanning={spanning}
        emptyIcon={PACKAGE_TYPE_ICON[type]}
        emptyAction={<EmptyStateAction action={createAction} />}
        list={list}
        view={view}
        onViewChange={setView}
      />
      {importing && canCreate && <ImportModal type={type} onClose={() => setImporting(false)} />}
      {creating !== null && canCreate && type !== "mcp-server" && (
        <CreatePackageModal
          type={type}
          integrationId={creating.integrationId ?? undefined}
          onClose={() => setCreating(null)}
        />
      )}
      {creation.isOpen && (
        <CreationHandoffModal
          resource={type}
          onClose={creation.close}
          onManual={
            type === "mcp-server"
              ? undefined
              : () => {
                  creation.close();
                  setCreating({ integrationId: creation.integrationId });
                }
          }
          onImport={() => {
            creation.close();
            setImporting(true);
          }}
          onChat={creation.openChat}
          integration={integration}
        />
      )}
      {create.picker}
      {browse.picker}
    </>
  );
}
