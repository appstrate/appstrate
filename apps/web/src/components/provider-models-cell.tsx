// SPDX-License-Identifier: Apache-2.0

/** The Models cell of the providers table: the models a provider makes usable. */

import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { OrgModelInfo } from "../hooks/use-models";
import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";
import type { ProviderRow } from "../lib/model-providers";
import { isModelUnpriced } from "../pages/org-settings/model-pricing";

/** How many models a row names before « +N »: the rest is in the row's title and its dialog. */
const NAMED_MODELS = 3;

function ModelName({ model }: { model: OrgModelInfo }) {
  const { t } = useTranslation("settings");
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="min-w-0 break-words">{model.label}</span>
      {model.is_default && <Badge variant="success">{t("models.default")}</Badge>}
      {isModelUnpriced(model) && (
        <span title={t("models.unpricedHint")} className="inline-flex shrink-0">
          <TriangleAlert className="text-warning size-3.5" aria-label={t("models.unpriced")} />
        </span>
      )}
    </span>
  );
}

/** A short list of models: the first few by name, the rest counted. */
function ModelList({ models }: { models: OrgModelInfo[] }) {
  const { t } = useTranslation("settings");
  const named = models.slice(0, NAMED_MODELS);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {named.map((m) => (
        <ModelName key={m.id} model={m} />
      ))}
      {models.length > named.length && (
        <span className="text-muted-foreground text-xs">+{models.length - named.length}</span>
      )}
      {models.length === 0 && (
        <span className="text-muted-foreground">{t("providers.noModels")}</span>
      )}
    </span>
  );
}

/** The models of a row; the instance's are told apart by service when it ships several. */
export function ModelsCell({
  row,
  registry,
}: {
  row: ProviderRow;
  registry: readonly ProviderRegistryEntry[];
}) {
  const title = row.models.map((m) => m.label).join(", ");
  if (row.kind !== "system" || row.serviceIds.length < 2) {
    return (
      <div className="min-w-0" title={title || undefined}>
        <ModelList models={row.models} />
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1" title={title}>
      {row.serviceIds.map((id) => (
        <div key={id} className="flex min-w-0 items-baseline gap-2">
          <span className="text-muted-foreground w-20 shrink-0 truncate text-xs">
            {registry.find((p) => p.providerId === id)?.displayName ?? id}
          </span>
          <ModelList models={row.models.filter((m) => m.providerId === id)} />
        </div>
      ))}
    </div>
  );
}
