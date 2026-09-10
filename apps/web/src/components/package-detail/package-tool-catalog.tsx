// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
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
import { EmptyState } from "../page-states";
import { Modal } from "../modal";
import { SettingsHeading } from "../settings/settings-heading";

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
  title,
}: {
  title?: string;
  tools: PackageTool[];
  inspection?: IntegrationToolInspection;
  selection?: {
    values: ReadonlySet<string>;
    onToggle: (name: string) => void;
    testIdPrefix: string;
  };
}) {
  const { t } = useTranslation("agents");
  const { t: ti } = useTranslation("settings");
  const [search, setSearch] = useState("");
  const [auths, setAuths] = useState<string[]>([]);
  const [exposures, setExposures] = useState<string[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [selected, setSelected] = useState<PackageTool | null>(null);
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
  const hasScopes = (tool: PackageTool) =>
    Object.values(tool.permissions ?? {}).some((scopes) => scopes.length > 0);
  const hasRules = (tool: PackageTool) => hasScopes(tool) || !!tool.inspection?.hidden_reason;
  const rulesLabel = (tool: PackageTool) =>
    [
      ...(tool.inspection?.hidden_reason
        ? [ti(`integration.inventory.rules.${tool.inspection.hidden_reason}`)]
        : []),
      ...(hasScopes(tool) ? [ti("integration.inventory.rules.required")] : []),
    ].join(" · ") || ti("integration.inventory.rules.none");
  const authKeys = [
    ...new Set(
      catalog.flatMap((tool) =>
        Object.entries(tool.permissions ?? {})
          .filter(([, scopes]) => scopes.length > 0)
          .map(([auth]) => auth),
      ),
    ),
  ];
  const needle = search.trim().toLocaleLowerCase();
  const rows = catalog.filter(
    (tool) =>
      `${tool.name} ${tool.description ?? ""}`.toLocaleLowerCase().includes(needle) &&
      (auths.length === 0 || auths.some((key) => (tool.permissions?.[key]?.length ?? 0) > 0)) &&
      (!inventory ||
        ((exposures.length === 0 || exposures.includes(tool.inspection!.exposure)) &&
          (origins.length === 0 || origins.includes(tool.inspection!.origin)) &&
          (rules.length === 0 || rules.includes(hasRules(tool) ? "with" : "without")))),
  );
  const columns: DataColumn<PackageTool>[] = [
    {
      id: "name",
      header: t("packageTools.name"),
      width: inventory ? "minmax(200px,2fr)" : "minmax(160px,1fr)",
      cell: (tool) => (
        <div
          className="flex items-start gap-2"
          data-testid={
            selection ? `${selection.testIdPrefix}${tool.name}` : `integration-tool-${tool.name}`
          }
        >
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
            header: t("packageTools.description"),
            width: "minmax(220px,2fr)" as const,
            cell: (tool: PackageTool) => (
              <span className="text-muted-foreground text-sm break-words">
                {tool.description || "–"}
              </span>
            ),
          },
        ]
      : [
          {
            id: "exposure",
            header: ti("integration.inventory.exposure"),
            width: "minmax(120px,1fr)" as const,
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
                {ti(`integration.inventory.exposure.${tool.inspection!.exposure}`)}
              </Badge>
            ),
          },
          {
            id: "origin",
            header: ti("integration.inventory.origin"),
            width: "minmax(130px,1fr)" as const,
            cell: (tool: PackageTool) => (
              <span className="text-muted-foreground text-xs">
                {ti(`integration.inventory.origin.${tool.inspection!.origin}`)}
              </span>
            ),
          },
          {
            id: "rules",
            header: ti("integration.inventory.rules"),
            width: "minmax(110px,1fr)" as const,
            cell: (tool: PackageTool) => (
              <span className="text-muted-foreground text-xs">{rulesLabel(tool)}</span>
            ),
          },
        ]),
    ...(!inventory && authKeys.length
      ? [
          {
            id: "permissions",
            header: t("packageTools.permissions"),
            width: "minmax(180px,1fr)" as const,
            cell: (tool: PackageTool) => (
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
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      {title ? (
        <SettingsHeading
          title={title}
          description={
            inventory ? (
              <span data-testid="tool-inventory-basis">
                {ti(`integration.inventory.basis.${inventory.basis}`)}
              </span>
            ) : undefined
          }
        />
      ) : (
        inventory && (
          <p
            className="text-muted-foreground text-sm leading-relaxed"
            data-testid="tool-inventory-basis"
          >
            {ti(`integration.inventory.basis.${inventory.basis}`)}
          </p>
        )
      )}
      <ListToolbar
        placement="panel"
        panelFiltersAdjacent
        search={{ value: search, onChange: setSearch, placeholder: t("packageTools.search") }}
        filters={[
          ...(inventory
            ? [
                {
                  id: "exposure",
                  label: ti("integration.inventory.exposure"),
                  values: exposures,
                  options: ["available", "hidden", "not_in_catalog"].map((value) => ({
                    value,
                    label: ti(`integration.inventory.exposure.${value}`),
                  })),
                  onChange: setExposures,
                },
                {
                  id: "rules",
                  label: ti("integration.inventory.rules"),
                  values: rules,
                  options: ["with", "without"].map((value) => ({
                    value,
                    label: ti(`integration.inventory.filter.${value}`),
                  })),
                  onChange: setRules,
                },
                {
                  id: "origin",
                  label: ti("integration.inventory.origin"),
                  values: origins,
                  options: ["mcp_package", "manifest", "appstrate"].map((value) => ({
                    value,
                    label: ti(`integration.inventory.origin.${value}`),
                  })),
                  onChange: setOrigins,
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
                  onChange: setAuths,
                },
              ]
            : []),
        ]}
        onReset={() => {
          setSearch("");
          setAuths([]);
          setExposures([]);
          setRules([]);
          setOrigins([]);
        }}
      />
      <DataTable
        label={t("manifest.tools")}
        columns={columns}
        rows={rows}
        rowKey={(tool) => tool.name}
        rowAction={inventory ? setSelected : undefined}
        rowLabel={(tool) => ti("integration.inventory.inspect", { name: tool.name })}
        surface="integrated"
        columnMode="scroll"
        empty={
          <EmptyState
            icon={Wrench}
            message={t(catalog.length ? "packageTools.noMatch" : "packageTools.empty")}
            compact
          />
        }
      />
      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
      >
        {selected?.inspection && (
          <div className="space-y-5 text-sm">
            {selected.description && <p>{selected.description}</p>}
            <dl className="space-y-4">
              <div>
                <dt className="text-muted-foreground text-xs">
                  {ti("integration.inventory.origin")}
                </dt>
                <dd className="mt-1">
                  {ti(`integration.inventory.origin.${selected.inspection.origin}`)}
                </dd>
                <dd className="text-muted-foreground mt-1 text-xs">
                  {ti(`integration.inventory.originDetail.${selected.inspection.origin}`)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  {ti("integration.inventory.exposure")}
                </dt>
                <dd className="mt-1">
                  {ti(`integration.inventory.exposure.${selected.inspection.exposure}`)}
                </dd>
                <dd className="text-muted-foreground mt-1">
                  {ti(
                    selected.inspection.hidden_reason
                      ? `integration.inventory.reason.${selected.inspection.hidden_reason}`
                      : selected.inspection.exposure === "not_in_catalog"
                        ? "integration.inventory.reason.not_in_catalog"
                        : "integration.inventory.agentSelection",
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">
                  {ti("integration.inventory.rules")}
                </dt>
                <dd className="mt-1">
                  {hasScopes(selected) ? (
                    <div className="space-y-3">
                      <code className="text-xs break-all">{`tools_policy[${JSON.stringify(selected.name)}].required_scopes`}</code>
                      {Object.entries(selected.permissions ?? {})
                        .filter(([, scopes]) => scopes.length > 0)
                        .map(([auth, scopes]) => (
                          <div key={auth}>
                            <p className="text-muted-foreground text-xs">{auth}</p>
                            <ul className="mt-1 space-y-1">
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
        )}
      </Modal>
    </>
  );
}
