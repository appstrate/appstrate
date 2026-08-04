// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { z } from "zod";

/** Portable reasoning vocabulary understood by the Appstrate Pi runtime. */
export const modelReasoningLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type ModelReasoningLevel = z.infer<typeof modelReasoningLevelSchema>;

/**
 * Persisted/requested generation settings. Null and omission both mean
 * "inherit"; zero is a meaningful temperature and must never be collapsed.
 */
export const modelGenerationSettingsSchema = z
  .object({
    temperature: z.number().finite().min(0).max(1).nullable().optional(),
    reasoningLevel: modelReasoningLevelSchema.nullable().optional(),
  })
  .strict();

export type ModelGenerationSettings = z.infer<typeof modelGenerationSettingsSchema>;

export const modelCapabilitySupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export type ModelCapabilitySupport = z.infer<typeof modelCapabilitySupportSchema>;

export const modelGenerationCapabilitiesSchema = z
  .object({
    temperature: modelCapabilitySupportSchema.default("unknown"),
    temperatureWithReasoning: modelCapabilitySupportSchema.default("unknown"),
    reasoning: z
      .object({
        supported: modelCapabilitySupportSchema.default("unknown"),
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
  temperatureWithReasoning: "unknown",
  reasoning: { supported: "unknown", adaptive: null, levels: {} },
};

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
 * Merge the agent and invocation layers, then validate only explicit upstream
 * refusals. Unknown catalog facts remain forward-compatible: the runtime
 * adapter/provider remains the final authority and can surface its own error.
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
    parsedOverride.reasoningLevel ?? parsedDefaults.reasoningLevel ?? undefined;

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
    parsedCapabilities.reasoning.levels[reasoningLevel] === "unsupported"
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
    parsedCapabilities.temperatureWithReasoning === "unsupported"
  ) {
    throw new ModelGenerationError(
      "temperature_with_reasoning_unsupported",
      "The selected model cannot combine a custom temperature with reasoning",
    );
  }

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
  };
}
