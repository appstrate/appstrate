// SPDX-License-Identifier: Apache-2.0

import {
  mapModelReasoningLevels,
  type ModelGenerationCapabilities,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { defaultReasoningLevel } from "./default-reasoning-level.ts";
import type { ModelGenerationControlLabels } from "./model-generation-controls.tsx";

/**
 * Wire every label of this control from one i18n key family, so the two
 * surfaces that render it (the model settings page and the chat model picker)
 * cannot drift apart.
 *
 * `t` must already be bound to a namespace that resolves `models.generation.*`
 * (`settings`, which is a boot namespace and therefore loaded on every route).
 * Where the server reports `reasoning.off: "unsent"`, `off` is named for what
 * it does on that model: no parameter, the server decides.
 */
export function buildGenerationLabels(
  t: (key: string, options?: { level: string }) => string,
  capabilities?: ModelGenerationCapabilities | null,
): ModelGenerationControlLabels {
  const offUnsent = capabilities?.reasoning.off === "unsent";
  const levelLabel = (level: ModelReasoningLevel) =>
    t(
      level === "off" && offUnsent
        ? "models.generation.levels.offSendsNothing"
        : `models.generation.levels.${level}`,
    );
  const defaultLevel = { level: levelLabel(defaultReasoningLevel(capabilities)) };
  const reasoningHint = t("models.generation.reasoningHint", defaultLevel);
  return {
    temperature: t("models.generation.temperature"),
    temperatureHint: t("models.generation.temperatureHint"),
    reasoning: t("models.generation.reasoning"),
    reasoningHint: offUnsent
      ? `${reasoningHint} ${t("models.generation.reasoningOffSendsNothingHint")}`
      : reasoningHint,
    inherit: t("models.generation.inherit"),
    inheritShort: t("models.generation.inheritShort"),
    reasoningInherit: t("models.generation.reasoningInherit", defaultLevel),
    unsupported: t("models.generation.unsupported"),
    unsupportedShort: t("models.generation.unsupportedShort"),
    levels: mapModelReasoningLevels(levelLabel),
    shortLevels: mapModelReasoningLevels((level) => t(`models.generation.levelsShort.${level}`)),
  };
}
