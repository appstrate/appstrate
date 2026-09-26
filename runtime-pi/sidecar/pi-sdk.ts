// SPDX-License-Identifier: Apache-2.0

/**
 * Pi SDK barrel for the SIDECAR image: the only file under `runtime-pi/sidecar/`
 * allowed to import `@earendil-works/pi-*` directly (`no-restricted-imports`),
 * separate from the agent's because the sidecar's Docker build copies only
 * `runtime-pi/sidecar/*.ts`. It carries pi-ai to terminate an aliased run's
 * `pi-messages` and re-originate against the real backing, so vendor quirks stay
 * derived by pi-ai rather than mirrored here (`MODEL_ALIASES.md`). `./api/*`
 * and `./providers/all` subpaths plus the root; model records come via runner-pi's `pi-model`.
 */

import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as mistralConversations } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  normalizeContext,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AliasBackingApiShape } from "@appstrate/core/model-swap";
import { trimTrailingSlashes } from "@appstrate/runner-pi/llm-proxy-routes";

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

const BUILTIN_PROVIDERS = builtinProviders();
const PROVIDER_BY_ID = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider]));
const PROVIDER_BY_BASE_URL = new Map(
  BUILTIN_PROVIDERS.flatMap((provider) =>
    provider.getModels().map((record) => [trimTrailingSlashes(record.baseUrl), provider] as const),
  ),
);

/**
 * Stream through pi-ai's built-in provider (by catalog endpoint, else `model.provider`) when
 * its catalog serves `model.api` — `compat.streamSimple`'s check — so provider-layer quirks
 * apply; else the raw per-API stream, whose cast holds as only a model of that `api` reaches it.
 */
export function streamBacking(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  // Providers take the branded `TranscriptContext`; the container's is already one.
  const transcript = normalizeContext(context);
  const provider =
    PROVIDER_BY_BASE_URL.get(trimTrailingSlashes(model.baseUrl)) ??
    PROVIDER_BY_ID.get(model.provider);
  if (provider?.getModels().some((record) => record.api === model.api)) {
    return provider.streamSimple(model, transcript, options);
  }
  const impl = BACKING_STREAMS[model.api as AliasBackingApiShape] as
    | ((m: Model<Api>, c: TranscriptContext, o: SimpleStreamOptions) => AssistantMessageEventStream)
    | undefined;
  if (!impl) throw new Error(`pi-sdk: no pi-ai stream implementation for api "${model.api}"`);
  return impl(model, transcript, options);
}
