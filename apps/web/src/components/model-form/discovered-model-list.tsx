// SPDX-License-Identifier: Apache-2.0

/**
 * What an endpoint answered it serves, as a list to pick from.
 *
 * One detection describes every model at once, so adding them one at a time is
 * the same endpoint configured over and over: the rows are checkboxes and the
 * dialog's footer adds all of them in one go. A row shows only what the
 * description actually carried — `source` says whether the endpoint published
 * it or the catalog filled it in, and neither is claimed when nothing
 * described the model.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import type { DiscoveredModel } from "../../hooks/use-model-provider-credentials";

function DiscoveredModelRow({
  id,
  model,
  checked,
  onCheckedChange,
}: {
  id: string;
  model: DiscoveredModel;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const sourceLabel =
    model.source === "catalog"
      ? t("models.form.discoverSourceCatalog")
      : model.source === "endpoint"
        ? t("models.form.discoverSourceEndpoint")
        : null;

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(Boolean(v))} />
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer font-normal">
        <span className="block truncate">{model.label ?? model.id}</span>
        {model.label && (
          <span className="text-muted-foreground block truncate font-mono text-xs">{model.id}</span>
        )}
      </Label>
      {sourceLabel && (
        <Badge variant="secondary" className="shrink-0">
          {sourceLabel}
        </Badge>
      )}
      {model.context_window !== null && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {Math.round(model.context_window / 1000)}k
        </span>
      )}
    </div>
  );
}

export function DiscoveredModelList({
  models,
  selectedIds,
  onSelectionChange,
}: {
  models: readonly DiscoveredModel[];
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const allSelected = models.length > 0 && selectedIds.length === models.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id="mdl-discovered-all"
          checked={allSelected}
          onCheckedChange={(v) => onSelectionChange(v ? models.map((m) => m.id) : [])}
        />
        <Label htmlFor="mdl-discovered-all" className="cursor-pointer font-normal">
          {t("models.form.discoverSelectAll")}
        </Label>
      </div>
      <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
        {models.map((m, index) => (
          <DiscoveredModelRow
            key={m.id}
            id={`mdl-discovered-${index}`}
            model={m}
            checked={selectedIds.includes(m.id)}
            onCheckedChange={(checked) =>
              onSelectionChange(
                checked ? [...selectedIds, m.id] : selectedIds.filter((id) => id !== m.id),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}
