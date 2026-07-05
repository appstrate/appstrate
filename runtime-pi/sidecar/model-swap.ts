// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap for the in-container sidecar proxy. The implementation lives
 * in `@appstrate/core/model-swap` (the single source of truth, shared with the
 * platform LLM gateway in `apps/api`). This module re-exports it so the
 * sidecar's local imports and tests keep their stable `./model-swap` path.
 */

export {
  swapRequestModel,
  swapResponseModelJson,
  createSseModelSwapStream,
  syntheticAliasErrorBody,
  isAliasableApiShape,
  ALIASABLE_API_SHAPES,
  ALIAS_UPSTREAM_ERROR_MESSAGE,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "@appstrate/core/model-swap";
