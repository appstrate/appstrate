// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import {
  mapModelReasoningLevels,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

export function ModelGenerationFields({
  value,
  capabilities,
  onChange,
  disabled,
}: {
  value: ModelGenerationSettings;
  capabilities?: ModelGenerationCapabilities | null;
  onChange: (value: ModelGenerationSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["settings"]);

  return (
    <ModelGenerationControls
      value={value}
      capabilities={capabilities}
      onChange={onChange}
      disabled={disabled}
      labels={{
        temperature: t("models.generation.temperature"),
        temperatureHint: t("models.generation.temperatureHint"),
        reasoning: t("models.generation.reasoning"),
        reasoningHint: t("models.generation.reasoningHint"),
        inherit: t("models.generation.inherit"),
        inheritShort: t("models.generation.inheritShort"),
        unsupported: t("models.generation.unsupported"),
        unsupportedShort: t("models.generation.unsupportedShort"),
        levels: mapModelReasoningLevels((level) => t(`models.generation.levels.${level}`)),
        shortLevels: mapModelReasoningLevels((level) =>
          t(`models.generation.levelsShort.${level}`),
        ),
      }}
    />
  );
}
