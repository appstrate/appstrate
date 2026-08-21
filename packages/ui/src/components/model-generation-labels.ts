// SPDX-License-Identifier: Apache-2.0

import { mapModelReasoningLevels } from "@appstrate/core/model-generation";
import type { ModelGenerationControlLabels } from "./model-generation-controls.tsx";

/**
 * Wire every label of this control from one i18n key family, so the two
 * surfaces that render it (the model settings page and the chat model picker)
 * cannot drift apart. They used to keep parallel families — `models.generation.*`
 * in `settings.json` and `generation.*` in `chat.json` — 19 of whose 23 values
 * were byte-identical; the locale guard could not see the duplication because
 * it exempted both prefixes as dynamic.
 *
 * `t` must already be bound to a namespace that resolves `models.generation.*`
 * (`settings`, which is a boot namespace and therefore loaded on every route).
 */
export function buildGenerationLabels(t: (key: string) => string): ModelGenerationControlLabels {
  return {
    temperature: t("models.generation.temperature"),
    temperatureHint: t("models.generation.temperatureHint"),
    reasoning: t("models.generation.reasoning"),
    reasoningHint: t("models.generation.reasoningHint"),
    inherit: t("models.generation.inherit"),
    inheritShort: t("models.generation.inheritShort"),
    unsupported: t("models.generation.unsupported"),
    unsupportedShort: t("models.generation.unsupportedShort"),
    levels: mapModelReasoningLevels((level) => t(`models.generation.levels.${level}`)),
    shortLevels: mapModelReasoningLevels((level) => t(`models.generation.levelsShort.${level}`)),
  };
}
