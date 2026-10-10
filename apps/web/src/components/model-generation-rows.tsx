// SPDX-License-Identifier: Apache-2.0

/**
 * Temperature and reasoning as settings rows: one select each, offered only as
 * far as the model in use supports them. The agent's Modèle section and a
 * schedule's Exécution section show the same two rows; each owns what an
 * empty value inherits, hence `inheritLabels`.
 */

import { CircleSlash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { buildGenerationLabels } from "@appstrate/ui/components/model-generation-labels";
import {
  MODEL_REASONING_LEVELS,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import type { OrgModelInfo } from "../hooks/use-models";
import { SettingRow } from "./settings/setting-row";

const INHERIT = "__inherit__";
const UNSUPPORTED = "__unsupported__";

export function GenerationSettingRows({
  model,
  generation,
  disabled,
  inheritLabels,
  onChange,
}: {
  /** The model a run resolves to: its capabilities decide what is offered. */
  model: OrgModelInfo | undefined;
  generation: ModelGenerationSettings;
  disabled?: boolean;
  /** What "no value" means here, when it is not the provider's default. */
  inheritLabels?: { temperature?: string; reasoning?: string };
  onChange: (next: ModelGenerationSettings) => void;
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const temperatureUnsupported = model?.generation?.temperature === "unsupported";
  const supportedReasoningLevels = MODEL_REASONING_LEVELS.filter(
    (level) => model?.generation?.reasoning.levels[level] === "supported",
  );
  const reasoningUnsupported =
    model?.generation?.reasoning.supported === "unsupported" ||
    supportedReasoningLevels.length === 0;
  // The level names, the default level and the `off` of a model that sends
  // nothing for it (the API's `reasoning.off`), worded once for every surface.
  const labels = buildGenerationLabels(t, model?.generation);
  const temperatureOptions = [
    { value: INHERIT, label: inheritLabels?.temperature ?? t("models.generation.inherit") },
    { value: "0", label: t("detail.configuration.temperature.precise", { ns: "agents" }) },
    { value: "0.2", label: t("detail.configuration.temperature.focused", { ns: "agents" }) },
    { value: "0.5", label: t("detail.configuration.temperature.balanced", { ns: "agents" }) },
    { value: "0.8", label: t("detail.configuration.temperature.creative", { ns: "agents" }) },
    { value: "1", label: t("detail.configuration.temperature.exploratory", { ns: "agents" }) },
  ];
  const unsupportedItem = (
    <SelectItem value={UNSUPPORTED}>
      <span className="inline-flex items-center gap-2">
        <CircleSlash2 className="size-3.5" />
        {t("models.generation.unsupportedShort")}
      </span>
    </SelectItem>
  );
  const without = (key: keyof ModelGenerationSettings) => {
    const { [key]: _omit, ...rest } = generation;
    void _omit;
    return rest;
  };

  return (
    <>
      <SettingRow
        label={t("models.generation.temperature")}
        description={
          temperatureUnsupported
            ? t("models.generation.unsupported")
            : t("models.generation.temperatureHint")
        }
      >
        <Select
          value={
            temperatureUnsupported
              ? UNSUPPORTED
              : generation.temperature == null
                ? INHERIT
                : String(generation.temperature)
          }
          disabled={disabled || temperatureUnsupported}
          onValueChange={(value) =>
            onChange(
              value === INHERIT
                ? without("temperature")
                : { ...generation, temperature: Number(value) },
            )
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {temperatureUnsupported
              ? unsupportedItem
              : temperatureOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label={t("models.generation.reasoning")}
        description={
          reasoningUnsupported ? t("models.generation.unsupported") : labels.reasoningHint
        }
      >
        <Select
          value={reasoningUnsupported ? UNSUPPORTED : (generation.reasoning_level ?? INHERIT)}
          disabled={disabled || reasoningUnsupported}
          onValueChange={(value) =>
            onChange(
              value === INHERIT
                ? without("reasoning_level")
                : { ...generation, reasoning_level: value as ModelReasoningLevel },
            )
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {reasoningUnsupported ? (
              unsupportedItem
            ) : (
              <>
                <SelectItem value={INHERIT}>
                  {inheritLabels?.reasoning ?? labels.reasoningInherit}
                </SelectItem>
                {supportedReasoningLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {labels.levels[level]}
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
      </SettingRow>
    </>
  );
}
