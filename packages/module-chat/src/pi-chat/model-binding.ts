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
  type Api,
  type ExtensionFactory,
  type Model,
} from "@appstrate/runner-pi";
import type { OrgModel } from "../llm.ts";

interface PiChatModelBindingBase {
  /** Fully resolved Pi model. No provider secret is ever stored on this object. */
  model: Model<Api>;
  /** AuthStorage key derived from the Pi API shape. */
  provider: string;
}

export interface PiProxyModelBinding extends PiChatModelBindingBase {
  authMode: "proxy";
  /**
   * Inert placeholder registered on the runtime so the provider counts as
   * authenticated. It authorizes nothing: {@link authExtension} overwrites the
   * Authorization header on every request, and llm-proxy never forwards it.
   */
  runtimeApiKey: "proxy";
  /** Per-request bearer injection through Pi's provider-header lifecycle hook. */
  authExtension: ExtensionFactory;
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

/**
 * Chat already resolves one concrete model before entering Pi. The targeted
 * credential setup refreshes that provider afterwards, so a full catalog and
 * availability refresh during every runtime construction is redundant.
 */
export const PI_CHAT_MODEL_RUNTIME_CREATE_OPTIONS = {
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
} as const;

export type PiChatModelBindingResolution =
  | { status: "ready"; binding: ResolvedPiChatModelBinding }
  | { status: "needs-reconnection" }
  | { status: "unsupported" };

/**
 * llm-proxy base URL per family, in the shape PI expects — NOT the one
 * `proxyTarget` (`../llm.ts`) hands the AI SDK. Both tables end on the same
 * absolute URL; they differ because each client appends a different path:
 * pi-ai's Anthropic client appends `/v1/messages` and its Mistral transport
 * appends `v1/chat/completions`, so the `/v1` the AI SDK path carries in its
 * base would be duplicated here. Change one table and re-derive the other from
 * the client's own path building, never by copying the string across.
 */
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

/** Inject a fresh process-local bearer into every provider request. */
export function createPiProxyAuthExtension(mintBearer: () => string): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_headers", (event) => {
      event.headers.authorization = `Bearer ${mintBearer()}`;
    });
  };
}

export function createPiProxyModelBinding(args: {
  model: OrgModel;
  origin: string;
  mintBearer: () => string;
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
    authExtension: createPiProxyAuthExtension(args.mintBearer),
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
}): PiChatModelBindingResolution {
  if (args.subscription.subscription) {
    if ("needsReconnection" in args.subscription) return { status: "needs-reconnection" };
    return { status: "ready", binding: createPiOAuthModelBinding(args.subscription.model) };
  }
  const binding = createPiProxyModelBinding(args);
  return binding ? { status: "ready", binding } : { status: "unsupported" };
}
