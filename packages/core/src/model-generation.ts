// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { z } from "zod";

/** Portable reasoning vocabulary: Pi's `ModelThinkingLevel`, accepted by Appstrate. */
export const MODEL_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const modelReasoningLevelSchema = z.enum(MODEL_REASONING_LEVELS);

export type ModelReasoningLevel = z.infer<typeof modelReasoningLevelSchema>;

const ANTHROPIC_REASONING_BUDGET_TOKENS = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
} satisfies Record<Exclude<ModelReasoningLevel, "off">, number>;

/** Translate portable effort to Anthropic's classic token-budget transport. */
export function anthropicReasoningBudgetTokens(level: Exclude<ModelReasoningLevel, "off">): number {
  return ANTHROPIC_REASONING_BUDGET_TOKENS[level];
}

/**
 * Request-scoped thinking budget for a classic (non-adaptive) Anthropic call,
 * shaped for pi-ai's `SimpleStreamOptions.thinkingBudgets`. The returned key is
 * pi's clamped slot — it collapses `xhigh` and `max` onto `high` — not the
 * requested level. Applied both by the runner and by the sidecar re-originating
 * an aliased run.
 */
export function anthropicThinkingBudgets(
  level: ModelReasoningLevel,
): Partial<Record<Exclude<ModelReasoningLevel, "off" | "xhigh" | "max">, number>> | undefined {
  if (level === "off") return undefined;
  const piSlot = level === "xhigh" || level === "max" ? "high" : level;
  return { [piSlot]: anthropicReasoningBudgetTokens(level) };
}

/** Map every portable reasoning level without duplicating the vocabulary. */
export function mapModelReasoningLevels<T>(
  map: (level: ModelReasoningLevel) => T,
): Record<ModelReasoningLevel, T> {
  return Object.fromEntries(MODEL_REASONING_LEVELS.map((level) => [level, map(level)])) as Record<
    ModelReasoningLevel,
    T
  >;
}

/**
 * Persisted/requested generation settings. Null and omission both mean
 * "inherit"; zero is a meaningful temperature and must never be collapsed.
 */
export const modelGenerationSettingsSchema = z
  .object({
    temperature: z.number().finite().min(0).max(1).nullable().optional(),
    reasoning_level: modelReasoningLevelSchema.nullable().optional(),
  })
  .strict();

export type ModelGenerationSettings = z.infer<typeof modelGenerationSettingsSchema>;

export const modelCapabilitySupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export type ModelCapabilitySupport = z.infer<typeof modelCapabilitySupportSchema>;

export const modelGenerationCapabilitiesSchema = z
  .object({
    temperature: modelCapabilitySupportSchema.default("unknown"),
    reasoning: z
      .object({
        supported: modelCapabilitySupportSchema.default("unknown"),
        temperature_compatible: modelCapabilitySupportSchema.optional(),
        adaptive: z.boolean().nullable().default(null),
        levels: z
          .partialRecord(modelReasoningLevelSchema, modelCapabilitySupportSchema)
          .default({}),
      })
      .default({ supported: "unknown", adaptive: null, levels: {} }),
  })
  .strict();

export type ModelGenerationCapabilities = z.infer<typeof modelGenerationCapabilitiesSchema>;

export const UNKNOWN_MODEL_GENERATION_CAPABILITIES: ModelGenerationCapabilities = {
  temperature: "unknown",
  reasoning: { supported: "unknown", adaptive: null, levels: {} },
};

/** Remove persisted/UI settings explicitly rejected by the selected model. */
export function reconcileModelGenerationSettings(
  value: ModelGenerationSettings,
  capabilities?: ModelGenerationCapabilities | null,
): ModelGenerationSettings {
  let next = value;

  if (next.temperature != null && capabilities?.temperature === "unsupported") {
    const { temperature: _temperature, ...rest } = next;
    void _temperature;
    next = rest;
  }

  const reasoningLevel = next.reasoning_level;
  if (
    reasoningLevel != null &&
    (capabilities?.reasoning.supported === "unsupported" ||
      capabilities?.reasoning.levels[reasoningLevel] !== "supported")
  ) {
    const { reasoning_level: _reasoningLevel, ...rest } = next;
    void _reasoningLevel;
    next = rest;
  }

  if (
    next.temperature != null &&
    next.reasoning_level != null &&
    next.reasoning_level !== "off" &&
    capabilities?.reasoning.temperature_compatible === "unsupported"
  ) {
    const { temperature: _temperature, ...rest } = next;
    void _temperature;
    next = rest;
  }

  return next;
}

export type ModelGenerationErrorCode =
  | "temperature_unsupported"
  | "reasoning_unsupported"
  | "reasoning_level_unsupported"
  | "temperature_with_reasoning_unsupported";

export class ModelGenerationError extends Error {
  readonly code: ModelGenerationErrorCode;

  constructor(code: ModelGenerationErrorCode, message: string) {
    super(message);
    this.name = "ModelGenerationError";
    this.code = code;
  }
}

export interface ResolveModelGenerationOptions {
  capabilities?: ModelGenerationCapabilities | null;
  defaults?: ModelGenerationSettings | null;
  override?: ModelGenerationSettings | null;
}

/**
 * Merge the agent and invocation layers, then validate catalog/provider facts.
 * Unknown temperature support remains forward-compatible, while reasoning
 * levels must always be explicitly confirmed before they can be selected.
 */
export function resolveModelGenerationSettings({
  capabilities = UNKNOWN_MODEL_GENERATION_CAPABILITIES,
  defaults,
  override,
}: ResolveModelGenerationOptions): ModelGenerationSettings {
  const parsedCapabilities = modelGenerationCapabilitiesSchema.parse(
    capabilities ?? UNKNOWN_MODEL_GENERATION_CAPABILITIES,
  );
  const parsedDefaults = modelGenerationSettingsSchema.parse(defaults ?? {});
  const parsedOverride = modelGenerationSettingsSchema.parse(override ?? {});

  const temperature = parsedOverride.temperature ?? parsedDefaults.temperature ?? undefined;
  const reasoningLevel =
    parsedOverride.reasoning_level ?? parsedDefaults.reasoning_level ?? undefined;

  if (temperature !== undefined && parsedCapabilities.temperature === "unsupported") {
    throw new ModelGenerationError(
      "temperature_unsupported",
      "The selected model does not support a custom temperature",
    );
  }

  if (
    reasoningLevel !== undefined &&
    reasoningLevel !== "off" &&
    parsedCapabilities.reasoning.supported === "unsupported"
  ) {
    throw new ModelGenerationError(
      "reasoning_unsupported",
      "The selected model does not support configurable reasoning",
    );
  }

  if (
    reasoningLevel !== undefined &&
    parsedCapabilities.reasoning.levels[reasoningLevel] !== "supported"
  ) {
    throw new ModelGenerationError(
      "reasoning_level_unsupported",
      `The selected model does not support reasoning level '${reasoningLevel}'`,
    );
  }

  if (
    temperature !== undefined &&
    reasoningLevel !== undefined &&
    reasoningLevel !== "off" &&
    parsedCapabilities.reasoning.temperature_compatible === "unsupported"
  ) {
    throw new ModelGenerationError(
      "temperature_with_reasoning_unsupported",
      "The selected model cannot combine a custom temperature with reasoning",
    );
  }

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningLevel !== undefined ? { reasoning_level: reasoningLevel } : {}),
  };
}
