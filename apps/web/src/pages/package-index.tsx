// SPDX-License-Identifier: Apache-2.0

/**
 * The index page of a package type the space runs: agents and skills. One page
 * for the two, so a fix to one (an error state, the keywords the search reads,
 * the actions menu) lands on both. Integrations have their own page: a source
 * filter and connection columns.
 *
 * In « Tous les espaces » it lists every space the reader reaches, each package
 * once naming its spaces. A row runs in one of its spaces; creating and
 * importing choose their space in their own menu (`useSpaceAction`).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PackageType } from "@appstrate/core/validation";
import { useAgents, usePackageList } from "../hooks/use-packages";
import { useListParams } from "../lib/list-params";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import { agentCardItem, packageCardItem, type CardItem } from "../lib/package-card-item";
import { PageHeader } from "../components/page-header";
import { PackageCollection } from "../components/package-collection";
import { usePackageColumns } from "../components/package-columns";
import { EmptyStateAction } from "../components/page-states";
import { useListView } from "../stores/list-view-store";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { CreatePackageModal } from "../components/create-package-modal";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useIntegrationDetail } from "../hooks/use-integrations";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useSpaceFilter } from "../hooks/use-space-filter";
import { inSpaces } from "../lib/space-filter";
import { usePackageIndexActions } from "../hooks/use-package-index-actions";

type IndexType = Extract<PackageType, "agent" | "skill">;

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
  const { data: agents, isLoading, error } = useAgents({ spanning });
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
  const [creating, setCreating] = useState<{ integrationId: string | null } | null>(null);
  const list = useListParams(["origin", "activity", "space"]);
  const [view, setView] = useListView(type);
  const { columns, menu } = useColumnVisibility(
    `packages-${type}`,
    usePackageColumns(type, spanning),
    type === "agent" ? AGENT_HIDDEN_COLUMNS : undefined,
  );
  const space = useSpaceFilter(type === "agent" ? "agents" : "skills", spanning);
  // The collection's own filters stay on the whole list; this one narrows the rows before them.
  const shownItems = items?.filter((item) => inSpaces(item.spaceIds, space.spaceIds));
  const words = presentation(type, t);
  const { canCreate, creation, importing, setImporting, createAction, actionsMenu } =
    usePackageIndexActions(type, words.create);
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
  return (
    <>
      <PageHeader
        title={words.title}
        variant="collection"
        breadcrumbs={[{ label: words.title }]}
        actions={actionsMenu}
      />
      <PackageCollection
        columns={columns}
        columnMenu={menu}
        tableId={`packages-${type}`}
        items={shownItems}
        extraFilters={space.filter ? [space.filter] : undefined}
        spaceNarrowing={
          space.mode === "team"
            ? {
                hiddenCount: (items?.length ?? 0) - (shownItems?.length ?? 0),
                message:
                  type === "agent"
                    ? t("common:spaceFilter.empty.agents")
                    : t("common:spaceFilter.empty.skills"),
                showAll: space.showAll,
              }
            : undefined
        }
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
      {creating !== null && canCreate && (
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
          onManual={() => {
            creation.close();
            setCreating({ integrationId: creation.integrationId });
          }}
          onImport={() => {
            creation.close();
            setImporting(true);
          }}
          onChat={creation.openChat}
          integration={integration}
        />
      )}
    </>
  );
}
