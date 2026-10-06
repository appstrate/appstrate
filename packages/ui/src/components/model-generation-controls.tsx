// SPDX-License-Identifier: Apache-2.0

import { useId } from "react";
import { CircleSlash2Icon } from "lucide-react";
import {
  MODEL_REASONING_LEVELS,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { cn } from "../cn.ts";
import { Badge } from "./badge.tsx";
import { Field, FieldDescription, FieldGroup, FieldTitle } from "./field.tsx";
import { Slider } from "./slider.tsx";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";

const INHERIT = "__inherit__";
/** Toggles per row when the levels wrap: "inherit" plus the first three levels. */
const ROW_BREAK = 4;
export interface ModelGenerationControlLabels {
  temperature: string;
  temperatureHint: string;
  reasoning: string;
  reasoningHint: string;
  inherit: string;
  inheritShort: string;
  /** What an unset reasoning level resolves to — not the provider's choice. */
  reasoningInherit: string;
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
}

function withoutTemperature(value: ModelGenerationSettings): ModelGenerationSettings {
  const { temperature: _temperature, ...rest } = value;
  void _temperature;
  return rest;
}

function withoutReasoning(value: ModelGenerationSettings): ModelGenerationSettings {
  const { reasoning_level: _reasoningLevel, ...rest } = value;
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
}: ModelGenerationControlsProps) {
  const id = useId();
  const temperatureUnsupported = capabilities?.temperature === "unsupported";
  const reasoningControlsUnavailable =
    capabilities?.reasoning.supported === "unsupported" ||
    !MODEL_REASONING_LEVELS.some((level) => capabilities?.reasoning.levels[level] === "supported");
  const temperatureDisabled = disabled || temperatureUnsupported;
  const reasoningDisabled = disabled || reasoningControlsUnavailable;
  const selectedTemperature =
    value.temperature == null ? labels.inherit : String(value.temperature);
  const selectedReasoning = value.reasoning_level
    ? labels.levels[value.reasoning_level]
    : labels.reasoningInherit;

  // Both breakpoints follow the space the control is GIVEN (a half-width card,
  // a dialog, a popover), not the viewport: the two fields sit side by side
  // only where each still fits the eight reasoning levels on one row.
  return (
    <div className="@container/generation w-full">
      <FieldGroup
        className={cn(
          "grid",
          compact ? "gap-2" : "gap-3",
          !stacked && "@xl/generation:grid-cols-2",
        )}
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

        {(!hideUnsupported || !reasoningControlsUnavailable) && (
          <Field
            data-disabled={reasoningDisabled || undefined}
            className={cn(
              "bg-card @container/reasoning min-w-0 rounded-lg border transition-colors",
              compact ? "gap-2 p-2.5" : "p-3",
              reasoningDisabled && "bg-muted/40 border-dashed",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <FieldTitle id={`${id}-reasoning-label`}>{labels.reasoning}</FieldTitle>
              <Badge
                variant={reasoningControlsUnavailable ? "secondary" : "outline"}
                className={cn("shrink-0 gap-1 truncate", compact ? "max-w-36" : "max-w-44")}
              >
                {reasoningControlsUnavailable && <CircleSlash2Icon className="size-3" />}
                {reasoningControlsUnavailable ? labels.unsupportedShort : selectedReasoning}
              </Badge>
            </div>
            <ToggleGroup
              type="single"
              value={value.reasoning_level ?? INHERIT}
              disabled={reasoningDisabled}
              variant="outline"
              aria-labelledby={`${id}-reasoning-label`}
              aria-describedby={compact ? undefined : `${id}-reasoning-description`}
              // Eight on one row from 2rem a level; below that, two rows of four.
              className="grid w-full grid-cols-4 gap-x-0 gap-y-1 @[16rem]/reasoning:grid-cols-8"
              onValueChange={(next) => {
                if (!next) return;
                onChange(
                  next === INHERIT
                    ? withoutReasoning(value)
                    : { ...value, reasoning_level: next as ModelReasoningLevel },
                );
              }}
            >
              <ToggleGroupItem
                value={INHERIT}
                aria-label={labels.reasoningInherit}
                title={labels.reasoningInherit}
                className="h-8 min-w-0 rounded-r-none px-1 text-[0.65rem]"
              >
                {labels.inheritShort}
              </ToggleGroupItem>
              {MODEL_REASONING_LEVELS.map((level, index) => (
                <ToggleGroupItem
                  key={level}
                  value={level}
                  disabled={capabilities?.reasoning.levels[level] !== "supported"}
                  aria-label={labels.levels[level]}
                  title={labels.levels[level]}
                  className={cn(
                    "-ml-px h-8 min-w-0 rounded-none px-1 text-[0.65rem]",
                    index === MODEL_REASONING_LEVELS.length - 1 && "rounded-r-md",
                    // The seam between the two rows of four.
                    index === ROW_BREAK - 2 && "@max-[16rem]/reasoning:rounded-r-md",
                    index === ROW_BREAK - 1 &&
                      "@max-[16rem]/reasoning:ml-0 @max-[16rem]/reasoning:rounded-l-md",
                  )}
                >
                  {labels.shortLevels[level]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {reasoningControlsUnavailable && !compact ? (
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
            ) : !reasoningControlsUnavailable && !compact ? (
              <FieldDescription id={`${id}-reasoning-description`}>
                {labels.reasoningHint}
              </FieldDescription>
            ) : null}
          </Field>
        )}
      </FieldGroup>
    </div>
  );
}
