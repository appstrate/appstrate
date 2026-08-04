// SPDX-License-Identifier: Apache-2.0

import { useId } from "react";
import { CircleSlash2Icon } from "lucide-react";
import type {
  ModelGenerationCapabilities,
  ModelGenerationSettings,
  ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { cn } from "../cn.ts";
import { Badge } from "./badge.tsx";
import { Field, FieldDescription, FieldGroup, FieldTitle } from "./field.tsx";
import { Slider } from "./slider.tsx";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";

const INHERIT = "__inherit__";
const REASONING_LEVELS: ModelReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface ModelGenerationControlLabels {
  temperature: string;
  temperatureHint: string;
  reasoning: string;
  reasoningHint: string;
  inherit: string;
  inheritShort: string;
  unsupported: string;
  unsupportedShort: string;
  levels: Record<ModelReasoningLevel, string>;
  shortLevels: Record<ModelReasoningLevel, string>;
}

export interface ModelGenerationControlsProps {
  value: ModelGenerationSettings;
  capabilities?: ModelGenerationCapabilities | null;
  labels: ModelGenerationControlLabels;
  onChange: (value: ModelGenerationSettings) => void;
  disabled?: boolean;
  stacked?: boolean;
  compact?: boolean;
  hideUnsupported?: boolean;
  className?: string;
}

function withoutTemperature(value: ModelGenerationSettings): ModelGenerationSettings {
  const { temperature: _temperature, ...rest } = value;
  void _temperature;
  return rest;
}

function withoutReasoning(value: ModelGenerationSettings): ModelGenerationSettings {
  const { reasoningLevel: _reasoningLevel, ...rest } = value;
  void _reasoningLevel;
  return rest;
}

/** Slider step 0 is provider default; steps 1–11 map to temperatures 0–1. */
function temperatureToStep(temperature: number | null | undefined): number {
  if (temperature == null) return 0;
  return Math.round(Math.min(1, Math.max(0, temperature)) * 10) + 1;
}

function stepToTemperature(step: number): number | undefined {
  if (step <= 0) return undefined;
  return (Math.min(11, Math.max(1, Math.round(step))) - 1) / 10;
}

export function ModelGenerationControls({
  value,
  capabilities,
  labels,
  onChange,
  disabled = false,
  stacked = false,
  compact = false,
  hideUnsupported = false,
  className,
}: ModelGenerationControlsProps) {
  const id = useId();
  const temperatureUnsupported = capabilities?.temperature === "unsupported";
  const reasoningUnsupported = capabilities?.reasoning.supported === "unsupported";
  const temperatureDisabled = disabled || temperatureUnsupported;
  const reasoningDisabled = disabled || reasoningUnsupported;
  const selectedTemperature =
    value.temperature == null ? labels.inherit : String(value.temperature);
  const selectedReasoning = value.reasoningLevel
    ? labels.levels[value.reasoningLevel]
    : labels.inherit;

  return (
    <FieldGroup
      className={cn("grid", compact ? "gap-2" : "gap-3", !stacked && "sm:grid-cols-2", className)}
    >
      {(!hideUnsupported || !temperatureUnsupported) && (
        <Field
          data-disabled={temperatureDisabled || undefined}
          className={cn(
            "bg-card min-w-0 rounded-lg border transition-colors",
            compact ? "gap-2 p-2.5" : "p-3",
            temperatureDisabled && "bg-muted/40 border-dashed",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <FieldTitle id={`${id}-temperature-label`}>{labels.temperature}</FieldTitle>
            <Badge
              variant={temperatureUnsupported ? "secondary" : "outline"}
              className={cn("shrink-0 gap-1 truncate", compact ? "max-w-36" : "max-w-44")}
            >
              {temperatureUnsupported && <CircleSlash2Icon className="size-3" />}
              {temperatureUnsupported ? labels.unsupportedShort : selectedTemperature}
            </Badge>
          </div>
          <Slider
            min={0}
            max={11}
            step={1}
            value={[temperatureToStep(value.temperature)]}
            disabled={temperatureDisabled}
            aria-labelledby={`${id}-temperature-label`}
            aria-describedby={compact ? undefined : `${id}-temperature-description`}
            onValueChange={(next) => {
              const temperature = stepToTemperature(next[0] ?? 0);
              onChange(
                temperature === undefined ? withoutTemperature(value) : { ...value, temperature },
              );
            }}
          />
          <div className="text-muted-foreground grid grid-cols-12 text-[0.65rem] leading-none">
            <span className="col-start-1 text-left">{labels.inheritShort}</span>
            <span className="col-start-2 text-left">0</span>
            <span className="col-start-7 text-center">0.5</span>
            <span className="col-start-12 text-right">1</span>
          </div>
          {temperatureUnsupported && !compact ? (
            <div
              id={`${id}-temperature-description`}
              className={cn(
                "bg-background/70 text-muted-foreground flex items-start gap-2 rounded-md border border-dashed text-xs",
                compact ? "px-2 py-1.5" : "px-2.5 py-2",
              )}
            >
              <CircleSlash2Icon className="mt-0.5 size-3.5 shrink-0" />
              <span>{labels.unsupported}</span>
            </div>
          ) : !temperatureUnsupported && !compact ? (
            <FieldDescription id={`${id}-temperature-description`}>
              {labels.temperatureHint}
            </FieldDescription>
          ) : null}
        </Field>
      )}

      {(!hideUnsupported || !reasoningUnsupported) && (
        <Field
          data-disabled={reasoningDisabled || undefined}
          className={cn(
            "bg-card min-w-0 rounded-lg border transition-colors",
            compact ? "gap-2 p-2.5" : "p-3",
            reasoningDisabled && "bg-muted/40 border-dashed",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <FieldTitle id={`${id}-reasoning-label`}>{labels.reasoning}</FieldTitle>
            <Badge
              variant={reasoningUnsupported ? "secondary" : "outline"}
              className={cn("shrink-0 gap-1 truncate", compact ? "max-w-36" : "max-w-44")}
            >
              {reasoningUnsupported && <CircleSlash2Icon className="size-3" />}
              {reasoningUnsupported ? labels.unsupportedShort : selectedReasoning}
            </Badge>
          </div>
          <ToggleGroup
            type="single"
            value={value.reasoningLevel ?? INHERIT}
            disabled={reasoningDisabled}
            variant="outline"
            aria-labelledby={`${id}-reasoning-label`}
            aria-describedby={compact ? undefined : `${id}-reasoning-description`}
            className="grid w-full grid-cols-7 gap-0"
            onValueChange={(next) => {
              if (!next) return;
              onChange(
                next === INHERIT
                  ? withoutReasoning(value)
                  : { ...value, reasoningLevel: next as ModelReasoningLevel },
              );
            }}
          >
            <ToggleGroupItem
              value={INHERIT}
              aria-label={labels.inherit}
              title={labels.inherit}
              className="h-8 min-w-0 rounded-r-none px-1 text-[0.65rem]"
            >
              {labels.inheritShort}
            </ToggleGroupItem>
            {REASONING_LEVELS.map((level, index) => (
              <ToggleGroupItem
                key={level}
                value={level}
                disabled={capabilities?.reasoning.levels[level] === "unsupported"}
                aria-label={labels.levels[level]}
                title={labels.levels[level]}
                className={cn(
                  "-ml-px h-8 min-w-0 rounded-none px-1 text-[0.65rem]",
                  index === REASONING_LEVELS.length - 1 && "rounded-r-md",
                )}
              >
                {labels.shortLevels[level]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {reasoningUnsupported && !compact ? (
            <div
              id={`${id}-reasoning-description`}
              className={cn(
                "bg-background/70 text-muted-foreground flex items-start gap-2 rounded-md border border-dashed text-xs",
                compact ? "px-2 py-1.5" : "px-2.5 py-2",
              )}
            >
              <CircleSlash2Icon className="mt-0.5 size-3.5 shrink-0" />
              <span>{labels.unsupported}</span>
            </div>
          ) : !reasoningUnsupported && !compact ? (
            <FieldDescription id={`${id}-reasoning-description`}>
              {labels.reasoningHint}
            </FieldDescription>
          ) : null}
        </Field>
      )}
    </FieldGroup>
  );
}
