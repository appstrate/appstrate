// SPDX-License-Identifier: Apache-2.0

/**
 * « Modèle par défaut » of Settings › Models: the model an agent falls back to when it names
 * none. The default also serves schedules, API keys and end users, so only a model an
 * organization connection serves is offered; the others stay in the list, greyed with their
 * reason (`defaultModelGroups`).
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@appstrate/ui/components/model-picker";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import { useSetDefaultModel, type OrgModelInfo } from "../../hooks/use-models";
import { defaultModelGroups, type ModelConfigInfo } from "../../lib/model-configs";
import { getModelIcon } from "../icons";
import { SaveFeedback } from "../settings/save-feedback";
import { SettingRow } from "../settings/setting-row";

export function DefaultModelSetting({
  models,
  configs,
  registry,
  canWrite,
}: {
  models: readonly OrgModelInfo[];
  configs: readonly ModelConfigInfo[];
  registry: readonly ProviderRegistryEntry[];
  /** `models:write`; otherwise the default is read, not chosen. */
  canWrite: boolean;
}) {
  const { t } = useTranslation("settings");
  const setDefault = useSetDefaultModel();
  const groups = useMemo(() => defaultModelGroups(models, configs), [models, configs]);
  const current = models.find((m) => m.is_default) ?? null;

  return (
    <SettingRow
      label={t("modelConfigs.default.label")}
      description={t("modelConfigs.default.description")}
      status={
        canWrite && (
          <SaveFeedback
            pending={setDefault.isPending}
            success={setDefault.isSuccess}
            error={setDefault.isError}
          />
        )
      }
    >
      {(labelId) =>
        canWrite ? (
          <div className="w-full max-w-md" aria-labelledby={labelId} role="group">
            <ModelPicker
              groups={groups}
              value={current?.id ?? null}
              onSelect={(modelId) => {
                if (modelId && modelId !== current?.id) setDefault.mutate({ body: { modelId } });
              }}
              labels={buildModelPickerLabels(t)}
              renderIcon={(model) => {
                const full = models.find((candidate) => candidate.id === model.id);
                const Icon = full && getModelIcon(full, registry);
                return Icon ? <Icon className="size-3.5 shrink-0" /> : null;
              }}
            />
          </div>
        ) : (
          <p className="text-sm">{current?.label ?? t("modelConfigs.default.none")}</p>
        )
      }
    </SettingRow>
  );
}
