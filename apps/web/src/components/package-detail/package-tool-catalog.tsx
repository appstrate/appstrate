// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import type {
  IntegrationToolInspection,
  IntegrationToolInspectionEntry,
} from "@appstrate/core/integration";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Badge } from "@appstrate/ui/components/badge";
import { DataTable, type DataColumn } from "../data-table";
import { ListToolbar } from "../list-toolbar";
import { EmptyState, NoMatchState } from "../page-states";
import { Modal } from "../modal";
import { useUrlModalTarget } from "../../hooks/use-url-modal";
import { CellEmpty } from "../table-cells";
import { rowActionsColumn } from "../row-actions-column";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";

const EXPOSURES = ["available", "hidden", "not_in_catalog"] as const;
const RULE_FILTERS = ["with", "without"] as const;
const ORIGINS = ["mcp_package", "manifest", "appstrate"] as const;

export interface PackageTool {
  name: string;
  description?: string;
  permissions?: Readonly<Record<string, readonly string[]>>;
  inspection?: IntegrationToolInspectionEntry;
}

/** One tool catalog for read-only package details and optional bundle selection. */
export function PackageToolCatalog({
  tools,
  selection,
  inspection,
  integrationId,
  actions,
  rowActions,
  showBasis = true,
}: {
  /** Off where the section heading already says where the list comes from. */
  showBasis?: boolean;
  /** The list's one "Actions" menu, when the catalog is edited where it is read. */
  actions?: ReactNode;
  /** A row's "…" menu, likewise. */
  rowActions?: (tool: PackageTool) => ReactNode;
  tools: PackageTool[];
  inspection?: IntegrationToolInspection;
  /**
   * Names the catalog in the URL: a tool's inspection opens at
   * `?inspectTool=<integrationId>:<tool name>`.
   */
  integrationId?: string;
  selection?: {
    values: ReadonlySet<string>;
    onToggle: (name: string) => void;
  };
}) {
  const { t } = useTranslation(["agents", "settings"]);
  // Inspection is read-only and must never feed a bundle selection control.
  const inventory = !selection ? inspection : undefined;
  const catalog: PackageTool[] = inventory
    ? inventory.entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        permissions: entry.policy?.required_scopes,
        inspection: entry,
      }))
    : tools;
  const inspectKey = (tool: PackageTool) => `${integrationId ?? ""}:${tool.name}`;
  // A link to a tool this catalog does not hold (renamed, removed) drops the parameter.
  const inspect = useUrlModalTarget("inspectTool", inventory ? catalog : undefined, inspectKey);
  const selected = inspect.target ?? null;
  const hasScopes = (tool: PackageTool) =>
    Object.values(tool.permissions ?? {}).some((scopes) => scopes.length > 0);
  const hasRules = (tool: PackageTool) => hasScopes(tool) || !!tool.inspection?.hidden_reason;
  const rulesLabel = (tool: PackageTool) =>
    [
      ...(tool.inspection?.hidden_reason
        ? [t(`settings:integration.inventory.rules.${tool.inspection.hidden_reason}`)]
        : []),
      ...(hasScopes(tool) ? [t("settings:integration.inventory.rules.required")] : []),
    ].join(" · ") || t("settings:integration.inventory.rules.none");
  const authKeys = [
    ...new Set(
      catalog.flatMap((tool) =>
        Object.entries(tool.permissions ?? {})
          .filter(([, scopes]) => scopes.length > 0)
          .map(([auth]) => auth),
      ),
    ),
  ];
  const list = useLocalListParams();
  const auths = list.values("auth", authKeys);
  const exposures = list.values("exposure", EXPOSURES);
  const rules = list.values("rules", RULE_FILTERS);
  const origins = list.values("origin", ORIGINS);
  const rows = catalog.filter(
    (tool) =>
      matchesSearch(list.search, [tool.name, tool.description]) &&
      (auths.length === 0 || auths.some((key) => (tool.permissions?.[key]?.length ?? 0) > 0)) &&
      (!inventory ||
        ((exposures.length === 0 || exposures.includes(tool.inspection!.exposure)) &&
          (origins.length === 0 || origins.includes(tool.inspection!.origin)) &&
          (rules.length === 0 || rules.includes(hasRules(tool) ? "with" : "without")))),
  );
  const columns: DataColumn<PackageTool>[] = [
    {
      id: "name",
      header: t("log.tool"),
      width: inventory ? 200 : 160,
      elastic: true,
      cell: (tool) => (
        <div className="flex items-start gap-2">
          {selection && (
            <Checkbox
              className="mt-0.5"
              aria-label={t("packageTools.select", { name: tool.name })}
              checked={selection.values.has(tool.name)}
              onCheckedChange={() => selection.onToggle(tool.name)}
            />
          )}
          {inventory ? (
            <div className="min-w-0">
              <span className="text-foreground block text-sm font-medium break-words">
                {tool.name}
              </span>
              {tool.description && (
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  {tool.description}
                </span>
              )}
            </div>
          ) : (
            <span className="text-foreground text-sm font-medium break-words">{tool.name}</span>
          )}
        </div>
      ),
    },
    ...(!inventory
      ? [
          {
            id: "description",
            header: t("editor.fieldDescLabel"),
            width: 220,
            elastic: true as const,
            cell: (tool: PackageTool) =>
              tool.description ? (
                <span className="text-muted-foreground text-sm break-words">
                  {tool.description}
                </span>
              ) : (
                <CellEmpty />
              ),
          },
        ]
      : [
          {
            id: "exposure",
            header: t("settings:integration.inventory.exposure"),
            width: 120,
            elastic: true as const,
            cell: (tool: PackageTool) => (
              <Badge
                variant={
                  tool.inspection!.exposure === "available"
                    ? "success"
                    : tool.inspection!.exposure === "hidden"
                      ? "secondary"
                      : "warning"
                }
              >
                {t(`settings:integration.inventory.exposure.${tool.inspection!.exposure}`)}
              </Badge>
            ),
          },
          {
            id: "origin",
            header: t("settings:integration.inventory.origin"),
            width: 130,
            elastic: true as const,
            cell: (tool: PackageTool) => (
              <span className="text-muted-foreground text-xs">
                {t(`settings:integration.inventory.origin.${tool.inspection!.origin}`)}
              </span>
            ),
          },
          {
            id: "rules",
            header: t("settings:integration.inventory.rules"),
            width: 160,
            elastic: true as const,
            cell: (tool: PackageTool) =>
              hasScopes(tool) ? (
                <div className="flex flex-col gap-1.5">
                  {tool.inspection?.hidden_reason && (
                    <span className="text-muted-foreground text-xs">
                      {t(`settings:integration.inventory.rules.${tool.inspection.hidden_reason}`)}
                    </span>
                  )}
                  <ScopeBadges tool={tool} />
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">{rulesLabel(tool)}</span>
              ),
          },
        ]),
    ...(!inventory && authKeys.length
      ? [
          {
            id: "permissions",
            header: t("packageTools.permissions"),
            width: 180,
            elastic: true as const,
            cell: (tool: PackageTool) => <ScopeBadges tool={tool} />,
          },
        ]
      : []),
    ...(rowActions ? [rowActionsColumn(rowActions)] : []),
  ];

  return (
    <>
      {inventory && showBasis && (
        <p
          className="text-muted-foreground text-sm leading-relaxed"
          data-testid="tool-inventory-basis"
        >
          {t(`settings:integration.inventory.basis.${inventory.basis}`)}
        </p>
      )}
      <ListToolbar
        actions={actions}
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("packageTools.search"),
        }}
        filters={[
          ...(inventory
            ? [
                {
                  id: "exposure",
                  label: t("settings:integration.inventory.exposure"),
                  values: exposures,
                  options: EXPOSURES.map((value) => ({
                    value,
                    label: t(`settings:integration.inventory.exposure.${value}`),
                  })),
                  onChange: list.setValues("exposure"),
                },
                {
                  id: "rules",
                  label: t("settings:integration.inventory.rules"),
                  values: rules,
                  options: RULE_FILTERS.map((value) => ({
                    value,
                    label: t(`settings:integration.inventory.filter.${value}`),
                  })),
                  onChange: list.setValues("rules"),
                },
                {
                  id: "origin",
                  label: t("settings:integration.inventory.origin"),
                  values: origins,
                  options: ORIGINS.map((value) => ({
                    value,
                    label: t(`settings:integration.inventory.origin.${value}`),
                  })),
                  onChange: list.setValues("origin"),
                },
              ]
            : []),
          ...(authKeys.length
            ? [
                {
                  id: "auth",
                  label: t("packageTools.auth"),
                  values: auths,
                  options: authKeys.map((key) => ({ value: key, label: key })),
                  onChange: list.setValues("auth"),
                },
              ]
            : []),
        ]}
        onReset={list.reset}
      />
      <DataTable
        tableId="package-tools"
        label={t("manifest.tools")}
        columns={columns}
        rows={rows}
        rowKey={(tool) => tool.name}
        rowAction={inventory ? (tool) => inspect.open(inspectKey(tool)) : undefined}
        rowLabel={(tool) => t("settings:integration.inventory.inspect", { name: tool.name })}
        empty={
          catalog.length ? (
            <NoMatchState message={t("packageTools.noMatch")} onReset={list.reset} />
          ) : (
            <EmptyState icon={Wrench} message={t("packageTools.empty")} compact />
          )
        }
      />
      {selected?.inspection && (
        <Modal onClose={inspect.close} title={selected.name}>
          <div className="flex flex-col gap-5 text-sm">
            {selected.description && <p>{selected.description}</p>}
            <dl className="flex flex-col gap-4">
              <div>
                <dt className="text-muted-foreground text-xs">
                  {t("settings:integration.inventory.origin")}
                </dt>
                <dd className="mt-1">
                  {t(`settings:integration.inventory.origin.${selected.inspection.origin}`)}
                </dd>
                <dd className="text-muted-foreground mt-1 text-xs">
                  {t(`settings:integration.inventory.originDetail.${selected.inspection.origin}`)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  {t("settings:integration.inventory.exposure")}
                </dt>
                <dd className="mt-1">
                  {t(`settings:integration.inventory.exposure.${selected.inspection.exposure}`)}
                </dd>
                <dd className="text-muted-foreground mt-1">
                  {t(
                    selected.inspection.hidden_reason
                      ? `settings:integration.inventory.reason.${selected.inspection.hidden_reason}`
                      : selected.inspection.exposure === "not_in_catalog"
                        ? "settings:integration.inventory.reason.not_in_catalog"
                        : "settings:integration.inventory.agentSelection",
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  {t("settings:integration.inventory.rules")}
                </dt>
                <dd className="mt-1">
                  {hasScopes(selected) ? (
                    <div className="flex flex-col gap-3">
                      <code className="text-xs break-all">{`tools_policy[${JSON.stringify(selected.name)}].required_scopes`}</code>
                      {Object.entries(selected.permissions ?? {})
                        .filter(([, scopes]) => scopes.length > 0)
                        .map(([auth, scopes]) => (
                          <div key={auth}>
                            <p className="text-muted-foreground text-xs">{auth}</p>
                            <ul className="mt-1 flex flex-col gap-1">
                              {scopes.map((scope) => (
                                <li className="break-all" key={scope}>
                                  {scope}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                    </div>
                  ) : (
                    rulesLabel(selected)
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The scopes a tool requires, one badge each, its auth in the title. */
function ScopeBadges({ tool }: { tool: PackageTool }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(tool.permissions ?? {}).flatMap(([auth, scopes]) =>
        scopes.map((scope, index) => (
          <Badge
            key={`${auth}:${index}:${scope}`}
            variant="secondary"
            className="max-w-full"
            title={`${auth}: ${scope}`}
          >
            <span className="truncate">{scope}</span>
          </Badge>
        )),
      )}
    </div>
  );
}
