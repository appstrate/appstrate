// SPDX-License-Identifier: Apache-2.0

/**
 * Single import surface ("barrel") for the Pi SDK inside the SIDECAR image.
 *
 * This is the ONLY file under `runtime-pi/sidecar/` allowed to import from
 * `@earendil-works/pi-*` directly — enforced by the `no-restricted-imports`
 * ESLint guard (see `eslint.config.mjs`), same contract as
 * `runtime-pi/pi-sdk.ts` for the agent image and
 * `packages/runner-pi/src/pi-sdk.ts` for the runner. The sidecar needs its own
 * because its Docker build copies only `runtime-pi/sidecar/*.ts`; the agent's
 * barrel is not in the image.
 *
 * ## Why the sidecar carries pi-ai at all
 *
 * On an ALIASED run the agent container speaks `pi-messages` (see
 * `docs/architecture/MODEL_ALIASES.md`) and the sidecar terminates it,
 * re-originating the call against the real backing through pi-ai. Every vendor
 * quirk — request shape AND response dialect — therefore keeps being derived by
 * pi-ai itself, one process to the left of the container. NOTHING is mirrored
 * here: transcribing pi-ai's `detectCompat` would be a blacklist over a set
 * nobody can enumerate, and it would need a parity oracle to stay honest.
 *
 * ## Why the `./api/*` subpaths, not the package root or `/compat`
 *
 * Either of those pulls pi-ai's generated provider catalog
 * (`dist/providers/data`, ~616 KB of vendor metadata the sidecar never reads).
 * `/compat` would also hand us a ready-made `streamSimple` dispatcher, at that
 * price; {@link streamBacking} below is the same dispatch in eight lines.
 * Importing the five aliasable API implementations directly costs +0.31 MB on
 * the compiled `bun build --compile` binary (61,993,888 → 62,324,128 bytes).
 *
 * Rationale + fork-contingency plan: `docs/architecture/SUPPLY_CHAIN.md`.
 */

import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as mistralConversations } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as openaiCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

// --- types (erased at runtime) ---
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
 * The stream implementation of each protocol an alias can be backed by.
 *
 * `streamSimple` and not `stream`: its option type (`SimpleStreamOptions`) is
 * the vendor-NEUTRAL one — `reasoning` as a portable `ThinkingLevel` rather
 * than each vendor's own `effort` / `reasoningEffort` / `thinkingEnabled`
 * spelling — which is exactly the vocabulary `pi-messages` puts on the wire.
 * Mapping it onto the vendor's own knobs is what each `streamSimple` wrapper
 * does, from the backing model's `thinkingLevelMap`; doing it here instead
 * would be the transcription this design exists to avoid.
 *
 * Keyed by pi's api id, which is Appstrate's `ModelApiShape` verbatim (pinned
 * by `_ApiShapeSubsetOfPi` in `pi-runner.ts`). Only the five ALIASABLE shapes
 * appear: the url-model families (`google-*`, `azure-*`, `bedrock-*`) cannot
 * back an alias at all (`isAliasableApiShape`), so shipping their SDKs would
 * be dead weight in the image.
 */
const BACKING_STREAMS = {
  "anthropic-messages": anthropicMessages,
  "mistral-conversations": mistralConversations,
  "openai-codex-responses": openaiCodexResponses,
  "openai-completions": openaiCompletions,
  "openai-responses": openaiResponses,
} as const;

/** The api ids {@link streamBacking} can dispatch. */
type BackingApiShape = keyof typeof BACKING_STREAMS;

/**
 * Dispatch a stream to pi-ai's implementation of `model.api`.
 *
 * The widening cast is the one place it happens, and it is the same widening
 * pi-ai performs in its own api registry: `registerApiProvider` accepts a
 * narrow `ApiProvider<TApi>` and stores it as a wide `ApiProviderInternal`.
 * It is sound for the same reason — an entry is only ever reached by a model
 * whose `api` IS its key, and pi-ai's own `wrapStream` throws `Mismatched api`
 * if that were ever violated. Without it, the per-api signatures
 * (`(model: Model<"anthropic-messages">) => …`) are contravariantly
 * incompatible with any common parameter type under `strictFunctionTypes`.
 */
export function streamBacking(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): AssistantMessageEventStream {
  const impl = BACKING_STREAMS[model.api as BackingApiShape] as
    | ((m: Model<Api>, c: Context, o: SimpleStreamOptions) => AssistantMessageEventStream)
    | undefined;
  if (!impl) throw new Error(`pi-sdk: no pi-ai stream implementation for api "${model.api}"`);
  return impl(model, context, options);
}
