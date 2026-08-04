// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type {
  ModelGenerationCapabilities,
  ModelGenerationSettings,
  ModelReasoningLevel,
} from "@appstrate/core/model-generation";

const INHERIT = "__inherit__";
const LEVELS: ModelReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
  const temperatureUnsupported = capabilities?.temperature === "unsupported";
  const reasoningUnsupported = capabilities?.reasoning.supported === "unsupported";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="model-temperature">{t("models.generation.temperature")}</Label>
        <Input
          id="model-temperature"
          type="number"
          min={0}
          max={1}
          step={0.1}
          placeholder={t("models.generation.inherit")}
          value={value.temperature ?? ""}
          disabled={disabled || temperatureUnsupported}
          onChange={(event) => {
            const raw = event.target.value;
            const { temperature: _temperature, ...rest } = value;
            void _temperature;
            onChange(raw === "" ? rest : { ...rest, temperature: Number(raw) });
          }}
        />
        <p className="text-muted-foreground text-xs">
          {temperatureUnsupported
            ? t("models.generation.unsupported")
            : t("models.generation.temperatureHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label>{t("models.generation.reasoning")}</Label>
        <Select
          value={value.reasoningLevel ?? INHERIT}
          disabled={disabled || reasoningUnsupported}
          onValueChange={(next) => {
            const { reasoningLevel: _reasoningLevel, ...rest } = value;
            void _reasoningLevel;
            onChange(
              next === INHERIT ? rest : { ...rest, reasoningLevel: next as ModelReasoningLevel },
            );
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{t("models.generation.inherit")}</SelectItem>
            {LEVELS.map((level) => (
              <SelectItem
                key={level}
                value={level}
                disabled={capabilities?.reasoning.levels[level] === "unsupported"}
              >
                {t(`models.generation.levels.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {reasoningUnsupported
            ? t("models.generation.unsupported")
            : t("models.generation.reasoningHint")}
        </p>
      </div>
    </div>
  );
}
