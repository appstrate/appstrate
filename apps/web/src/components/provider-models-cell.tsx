// SPDX-License-Identifier: Apache-2.0

/**
 * The Models cell of the providers tables: the models a provider makes usable, the default one
 * marked with a small star (the State column says when a row carries it).
 */

import { useTranslation } from "react-i18next";
import { Star, TriangleAlert } from "lucide-react";
import type { OrgModelInfo } from "../hooks/use-models";
import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";
import { isModelUnpriced } from "../pages/org-settings/model-pricing";

/** How many models a row names before « +N »: the rest is in the row's title and its dialog. */
const NAMED_MODELS = 3;

function ModelName({ model }: { model: OrgModelInfo }) {
  const { t } = useTranslation("settings");
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="min-w-0 break-words">{model.label}</span>
      {model.is_default && (
        <span title={t("models.default")} className="inline-flex shrink-0">
          <Star className="fill-warning text-warning size-3.5" aria-label={t("models.default")} />
        </span>
      )}
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

/** The models of a row; told apart by service when the row spans several (the instance's). */
export function ModelsCell({
  models,
  registry,
  serviceIds,
}: {
  models: OrgModelInfo[];
  /** Names the services of `serviceIds`. */
  registry?: readonly ProviderRegistryEntry[];
  serviceIds?: readonly string[];
}) {
  const title = models.map((m) => m.label).join(", ");
  if (!serviceIds || serviceIds.length < 2) {
    return (
      <div className="min-w-0" title={title || undefined}>
        <ModelList models={models} />
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1" title={title}>
      {serviceIds.map((id) => (
        <div key={id} className="flex min-w-0 items-baseline gap-2">
          <span className="text-muted-foreground w-20 shrink-0 truncate text-xs">
            {registry?.find((p) => p.providerId === id)?.displayName ?? id}
          </span>
          <ModelList models={models.filter((m) => m.providerId === id)} />
        </div>
      ))}
    </div>
  );
}
