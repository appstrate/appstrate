// SPDX-License-Identifier: Apache-2.0

import { useId } from "react";
import {
  MODEL_REASONING_LEVELS,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./field.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";

const INHERIT = "__inherit__";

export interface ModelGenerationControlLabels {
  temperature: string;
  temperatureHint: string;
  reasoning: string;
  reasoningHint: string;
  inherit: string;
  reasoningInherit: string;
  unsupported: string;
  unsupportedShort: string;
  levels: Record<ModelReasoningLevel, string>;
}

/** The same two controls in agent settings, schedules, launch options and chat. */
export function ModelGenerationControls({
  value,
  capabilities,
  labels,
  onChange,
  disabled,
}: {
  value: ModelGenerationSettings;
  capabilities?: ModelGenerationCapabilities | null;
  labels: ModelGenerationControlLabels;
  onChange: (value: ModelGenerationSettings) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const temperatureUnsupported = capabilities?.temperature === "unsupported";
  const levels = MODEL_REASONING_LEVELS.filter(
    (level) => capabilities?.reasoning.levels[level] === "supported",
  );
  const reasoningUnsupported =
    capabilities?.reasoning.supported === "unsupported" || levels.length === 0;
  // Keep values between the presets selectable, without rounding a saved setting.
  const temperatures = Array.from(
    new Set([
      ...Array.from({ length: 11 }, (_, index) => index / 10),
      ...(value.temperature == null ? [] : [value.temperature]),
    ]),
  ).sort((a, b) => a - b);

  const update = (key: keyof ModelGenerationSettings, next: string) => {
    const { [key]: _inherited, ...rest } = value;
    void _inherited;
    onChange(
      next === INHERIT
        ? rest
        : {
            ...value,
            [key]: key === "temperature" ? Number(next) : next,
          },
    );
  };

  return (
    <FieldGroup>
      <Field data-disabled={disabled || temperatureUnsupported || undefined}>
        <FieldLabel htmlFor={`${id}-temperature`}>{labels.temperature}</FieldLabel>
        <Select
          value={value.temperature == null ? INHERIT : String(value.temperature)}
          onValueChange={(next) => update("temperature", next)}
          disabled={disabled || temperatureUnsupported}
        >
          <SelectTrigger id={`${id}-temperature`} aria-describedby={`${id}-temperature-hint`}>
            <SelectValue>
              {temperatureUnsupported
                ? labels.unsupportedShort
                : (value.temperature ?? labels.inherit)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={INHERIT}>{labels.inherit}</SelectItem>
              {temperatures.map((temperature) => (
                <SelectItem key={temperature} value={String(temperature)}>
                  {temperature}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription id={`${id}-temperature-hint`}>
          {temperatureUnsupported ? labels.unsupported : labels.temperatureHint}
        </FieldDescription>
      </Field>
      <Field data-disabled={disabled || reasoningUnsupported || undefined}>
        <FieldLabel htmlFor={`${id}-reasoning`}>{labels.reasoning}</FieldLabel>
        <Select
          value={value.reasoning_level ?? INHERIT}
          onValueChange={(next) => update("reasoning_level", next)}
          disabled={disabled || reasoningUnsupported}
        >
          <SelectTrigger id={`${id}-reasoning`} aria-describedby={`${id}-reasoning-hint`}>
            <SelectValue>
              {reasoningUnsupported
                ? labels.unsupportedShort
                : value.reasoning_level
                  ? labels.levels[value.reasoning_level]
                  : labels.reasoningInherit}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={INHERIT}>{labels.reasoningInherit}</SelectItem>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {labels.levels[level]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription id={`${id}-reasoning-hint`}>
          {reasoningUnsupported ? labels.unsupported : labels.reasoningHint}
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
