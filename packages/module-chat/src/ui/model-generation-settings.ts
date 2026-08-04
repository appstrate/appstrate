// SPDX-License-Identifier: Apache-2.0

import type {
  ModelGenerationCapabilities,
  ModelGenerationSettings,
} from "@appstrate/core/model-generation";

/** Remove overrides that the newly selected model explicitly rejects. */
export function reconcileGenerationSettings(
  value: ModelGenerationSettings,
  capabilities?: ModelGenerationCapabilities | null,
): ModelGenerationSettings {
  let next = value;

  if (value.temperature != null && capabilities?.temperature === "unsupported") {
    const { temperature: _temperature, ...rest } = next;
    void _temperature;
    next = rest;
  }

  const reasoningLevel = next.reasoningLevel;
  if (
    reasoningLevel != null &&
    (capabilities?.reasoning.supported === "unsupported" ||
      capabilities?.reasoning.levels[reasoningLevel] === "unsupported")
  ) {
    const { reasoningLevel: _reasoningLevel, ...rest } = next;
    void _reasoningLevel;
    next = rest;
  }

  if (
    next.temperature != null &&
    next.reasoningLevel != null &&
    next.reasoningLevel !== "off" &&
    capabilities?.temperatureWithReasoning === "unsupported"
  ) {
    const { temperature: _temperature, ...rest } = next;
    void _temperature;
    next = rest;
  }

  return next;
}
