// SPDX-License-Identifier: Apache-2.0

/**
 * « Modèle par défaut » of Settings › Models: the model an agent falls back to when it names
 * none. The default also serves schedules, API keys and end users, so only a model an
 * organization connection serves is offered; the others stay in the list, greyed with their
 * reason (`defaultModelGroups`). A default no longer served says so under the setting, the
 * picker being the fix.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@appstrate/ui/components/model-picker";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";
import { useSetDefaultModel, type OrgModelInfo } from "../../hooks/use-models";
import { defaultModelGroups, type ModelConfigInfo } from "../../lib/model-configs";
import { getModelIcon } from "../icons";
import { SaveFeedback } from "../settings/save-feedback";
import { SettingRow } from "../settings/setting-row";

export function DefaultModelSetting({
  models,
  configs,
  credentials,
  registry,
  canWrite,
}: {
  models: readonly OrgModelInfo[];
  configs: readonly ModelConfigInfo[];
  /**
   * The connections, when the caller may read them (`model-provider-credentials:read`): the
   * organization's say which models serve the default. `undefined` when they may not: the
   * configuration's state decides.
   */
  credentials: readonly ModelProviderCredentialInfo[] | undefined;
  registry: readonly ProviderRegistryEntry[];
  /** `models:write`; otherwise the default is read, not chosen. */
  canWrite: boolean;
}) {
  const { t } = useTranslation("settings");
  const setDefault = useSetDefaultModel();
  const groups = useMemo(
    () => defaultModelGroups(models, configs, credentials),
    [models, configs, credentials],
  );
  const current = models.find((m) => m.is_default) ?? null;
  const labels = buildModelPickerLabels(t);
  const unserved = groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.model.id === current?.id)?.blocked;

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
          <div
            className="flex w-full max-w-md flex-col gap-2"
            aria-labelledby={labelId}
            role="group"
          >
            <ModelPicker
              groups={groups}
              value={current?.id ?? null}
              onSelect={(modelId) => {
                if (modelId && modelId !== current?.id) setDefault.mutate({ body: { modelId } });
              }}
              labels={labels}
              renderIcon={(model) => {
                const full = models.find((candidate) => candidate.id === model.id);
                const Icon = full && getModelIcon(full, registry);
                return Icon ? <Icon className="size-3.5 shrink-0" /> : null;
              }}
            />
            {current && unserved && (
              <Alert variant="warning" size="sm">
                <AlertTitle>
                  {t("modelConfigs.default.unserved", { model: current.label })}
                </AlertTitle>
                <AlertDescription>{labels.reasons[unserved]}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <p className="text-sm">{current?.label ?? t("modelConfigs.default.none")}</p>
        )
      }
    </SettingRow>
  );
}
