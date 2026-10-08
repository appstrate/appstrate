// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ModelGenerationControls } from "@appstrate/ui/components/model-generation-controls";
import { buildGenerationLabels } from "@appstrate/ui/components/model-generation-labels";
import type {
  ModelGenerationCapabilities,
  ModelGenerationSettings,
} from "@appstrate/core/model-generation";

export function ModelGenerationFields({
  value,
  model,
  onChange,
  disabled,
}: {
  value: ModelGenerationSettings;
  model?: { generation?: ModelGenerationCapabilities | null } | null;
  onChange: (value: ModelGenerationSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["settings"]);
  const capabilities = model?.generation;

  return (
    <ModelGenerationControls
      value={value}
      capabilities={capabilities}
      onChange={onChange}
      disabled={disabled}
      labels={buildGenerationLabels(t, capabilities)}
    />
  );
}
