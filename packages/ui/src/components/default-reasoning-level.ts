// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_MODEL_REASONING_LEVEL,
  MODEL_REASONING_LEVELS,
  type ModelGenerationCapabilities,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";

/**
 * The level an unset reasoning level resolves to on a model: the platform
 * default, else the nearest level the model takes, upward first. Restates Pi's
 * `clampThinkingLevel`, which the UI cannot import — parity is pinned by
 * `packages/runner-pi/test/default-reasoning-level-parity.test.ts`.
 */
export function defaultReasoningLevel(
  capabilities?: ModelGenerationCapabilities | null,
): ModelReasoningLevel {
  const takes = (level: ModelReasoningLevel) =>
    capabilities?.reasoning.levels[level] === "supported";
  const at = MODEL_REASONING_LEVELS.indexOf(DEFAULT_MODEL_REASONING_LEVEL);
  return (
    MODEL_REASONING_LEVELS.slice(at).find(takes) ??
    MODEL_REASONING_LEVELS.slice(0, at).reverse().find(takes) ??
    DEFAULT_MODEL_REASONING_LEVEL
  );
}
