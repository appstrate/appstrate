// SPDX-License-Identifier: Apache-2.0

/**
 * Pi SDK barrel for the SIDECAR image: the only file under `runtime-pi/sidecar/`
 * allowed to import `@earendil-works/pi-*` directly (`no-restricted-imports`),
 * separate from the agent's because the sidecar's Docker build copies only
 * `runtime-pi/sidecar/*.ts`. It carries pi-ai to terminate an aliased run's
 * `pi-messages` and re-originate against the real backing, so vendor quirks stay
 * derived by pi-ai rather than mirrored here (`MODEL_ALIASES.md`). `./api/*`
 * subpaths, not the root or `/compat`: those pull pi-ai's generated provider
 * catalog, hundreds of KB never read here (`SUPPLY_CHAIN.md`).
 */

import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as mistralConversations } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { AliasBackingApiShape } from "@appstrate/core/model-swap";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
export type { PiMessagesEvent } from "@earendil-works/pi-ai/api/pi-messages";

/**
 * Stream implementation per protocol an alias can be backed by. `streamSimple`,
 * not `stream`: its `SimpleStreamOptions` is the vendor-NEUTRAL type `pi-messages`
 * puts on the wire, mapped onto each vendor's knobs by the wrapper itself.
 * `satisfies` makes a backing shape with no stream here a TYPE error, and vice versa.
 */
const BACKING_STREAMS = {
  "anthropic-messages": anthropicMessages,
  "mistral-conversations": mistralConversations,
  "openai-codex-responses": openaiCodexResponses,
  "openai-completions": openaiCompletions,
  "openai-responses": openaiResponses,
} as const satisfies Record<AliasBackingApiShape, unknown>;

/**
 * Dispatch to pi-ai's implementation of `model.api`. The widening cast matches
 * pi-ai's own registry: sound because an entry is only reached by a model whose
 * `api` IS its key, and required by `strictFunctionTypes` contravariance.
 */
export function streamBacking(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  const impl = BACKING_STREAMS[model.api as AliasBackingApiShape] as
    | ((m: Model<Api>, c: Context, o: SimpleStreamOptions) => AssistantMessageEventStream)
    | undefined;
  if (!impl) throw new Error(`pi-sdk: no pi-ai stream implementation for api "${model.api}"`);
  return impl(model, context, options);
}
