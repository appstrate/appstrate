// SPDX-License-Identifier: Apache-2.0

/**
 * The single model-binding seam for the in-process Pi chat engine.
 *
 * API-key models keep their provider secret behind llm-proxy. Pi sees the
 * Appstrate preset id, a proxy URL and the inert runtime key `proxy`; the
 * transport mints a fresh process-local bearer immediately before every model
 * request. OAuth subscriptions use Pi's native provider request shape with the
 * freshly resolved access token held only in the in-memory AuthStorage.
 */

import type {
  ChatUsageRecord,
  SubscriptionChatModel,
  SubscriptionChatResolution,
} from "@appstrate/core/chat-contract";
import {
  deriveProviderFromApi,
  streamSimple,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@appstrate/runner-pi";
import type { OrgModel } from "../llm.ts";

export type PiModelStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

interface PiChatModelBindingBase {
  /** Fully resolved Pi model. No provider secret is ever stored on this object. */
  model: Model<Api>;
  /** AuthStorage key derived from the Pi API shape. */
  provider: string;
}

export interface PiProxyModelBinding extends PiChatModelBindingBase {
  authMode: "proxy";
  /** Inert value required by provider serializers. */
  runtimeApiKey: "proxy";
  /** Per-request bearer-injecting transport. */
  stream: PiModelStream;
  /** llm-proxy owns usage attribution and persistence. */
  metering: { kind: "proxy" };
}

export interface PiOAuthModelBinding extends PiChatModelBindingBase {
  authMode: "oauth2";
  /** Fresh OAuth access token, held in memory for this turn only. */
  runtimeApiKey: string;
  /** The in-process engine records usage because this call bypasses llm-proxy. */
  metering: { kind: "inline"; cost: ChatUsageRecord["cost"] };
}

export type ResolvedPiChatModelBinding = PiProxyModelBinding | PiOAuthModelBinding;

export type PiChatModelBindingResolution =
  | { status: "ready"; binding: ResolvedPiChatModelBinding }
  | { status: "needs-reconnection" }
  | { status: "unsupported" };

function proxyBaseUrl(origin: string, apiShape: string): string | null {
  switch (apiShape) {
    case "openai-completions":
      return `${origin}/api/llm-proxy/openai-completions/v1`;
    case "anthropic-messages":
      return `${origin}/api/llm-proxy/anthropic-messages`;
    case "mistral-conversations":
      return `${origin}/api/llm-proxy/mistral-conversations`;
    default:
      return null;
  }
}

function toPiModel(input: {
  id: string;
  label?: string;
  apiShape: string;
  baseUrl: string;
  reasoning?: boolean | null;
  reasoningLevelMap?: SubscriptionChatModel["reasoningLevelMap"];
  input?: string[] | null;
  cost?: ChatUsageRecord["cost"];
  contextWindow?: number | null;
  maxTokens?: number | null;
}): Model<Api> {
  const provider = deriveProviderFromApi(input.apiShape);
  return {
    id: input.id,
    name: input.label ?? input.id,
    api: input.apiShape as Api,
    provider,
    baseUrl: input.baseUrl,
    reasoning: input.reasoning === true,
    ...(input.reasoningLevelMap ? { thinkingLevelMap: input.reasoningLevelMap } : {}),
    input: (input.input ?? ["text"]) as Model<Api>["input"],
    cost: (input.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }) as Model<Api>["cost"],
    contextWindow: input.contextWindow ?? undefined,
    maxTokens: input.maxTokens ?? undefined,
  } as Model<Api>;
}

/**
 * Wrap Pi's native stream function without interpreting its result. Abort
 * signals, timeout failures, rate limits and provider errors remain native Pi
 * outcomes; this adapter only replaces the authorization header.
 */
export function createPiProxyStream(options: {
  mintBearer: () => string;
  stream?: PiModelStream;
}): PiModelStream {
  const delegate = options.stream ?? streamSimple;
  return (model, context, streamOptions) => {
    const headers = new Headers(streamOptions?.headers);
    headers.set("authorization", `Bearer ${options.mintBearer()}`);
    return delegate(model, context, {
      ...streamOptions,
      apiKey: "proxy",
      headers: Object.fromEntries(headers.entries()),
    });
  };
}

export function createPiProxyModelBinding(args: {
  model: OrgModel;
  origin: string;
  mintBearer: () => string;
  stream?: PiModelStream;
}): PiProxyModelBinding | null {
  const baseUrl = proxyBaseUrl(args.origin, args.model.apiShape);
  if (!baseUrl) return null;

  const model = toPiModel({
    // llm-proxy resolves this preset id and replaces it with the real upstream
    // model. Passing modelId here would bypass aliasing and usage attribution.
    id: args.model.id,
    label: args.model.label,
    apiShape: args.model.apiShape,
    baseUrl,
    reasoning: args.model.reasoning ?? args.model.generation?.reasoning.supported === "supported",
    reasoningLevelMap: args.model.generation?.reasoning.nativeLevels,
    input: args.model.input,
    cost: args.model.cost,
    contextWindow: args.model.contextWindow,
    maxTokens: args.model.maxTokens,
  });

  return {
    authMode: "proxy",
    model,
    provider: model.provider,
    runtimeApiKey: "proxy",
    stream: createPiProxyStream({ mintBearer: args.mintBearer, stream: args.stream }),
    metering: { kind: "proxy" },
  };
}

export function createPiOAuthModelBinding(model: SubscriptionChatModel): PiOAuthModelBinding {
  const piModel = toPiModel({
    id: model.modelId,
    apiShape: model.apiShape,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    reasoningLevelMap: model.reasoningLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
  return {
    authMode: "oauth2",
    model: piModel,
    provider: piModel.provider,
    runtimeApiKey: model.accessToken,
    metering: { kind: "inline", cost: model.cost },
  };
}

/** Resolve authentication and model shape before the engine-routing branch. */
export function resolvePiChatModelBinding(args: {
  model: OrgModel;
  subscription: SubscriptionChatResolution;
  origin: string;
  mintBearer: () => string;
  stream?: PiModelStream;
}): PiChatModelBindingResolution {
  if (args.subscription.subscription) {
    if ("needsReconnection" in args.subscription) return { status: "needs-reconnection" };
    return { status: "ready", binding: createPiOAuthModelBinding(args.subscription.model) };
  }
  const binding = createPiProxyModelBinding(args);
  return binding ? { status: "ready", binding } : { status: "unsupported" };
}
