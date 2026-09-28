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
  ChatModelResolution,
} from "@appstrate/core/chat-contract";
import { llmProxyBaseUrl, type Api, type ExtensionFactory, type Model } from "@appstrate/runner-pi";
import { buildPiModel } from "@appstrate/runner-pi/pi-model";
import type { OrgModel } from "../llm.ts";

interface PiChatModelBindingBase {
  /** Fully resolved Pi model. No provider secret is ever stored on this object. */
  model: Model<Api>;
  /** AuthStorage key: the model's Pi provider key. */
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

type PiChatModelBindingResolution =
  | { status: "ready"; binding: ResolvedPiChatModelBinding }
  | { status: "needs-reconnection" }
  | { status: "unsupported" };

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
  const baseUrl = llmProxyBaseUrl(args.origin, args.model.apiShape);
  if (!baseUrl) return null;

  const support = args.model.generation?.reasoning.supported;
  const model = buildPiModel({
    // llm-proxy resolves this preset id and replaces it with the real upstream
    // model. Passing modelId here would bypass aliasing and usage attribution.
    id: args.model.id,
    // The loopback listing is unprojected: an alias carries its backing's id.
    registryModelId: args.model.modelId,
    apiShape: args.model.apiShape,
    piProvider: args.model.pi_provider,
    baseUrl,
    reasoning:
      args.model.reasoning ??
      (support && support !== "unknown" ? support === "supported" : undefined),
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

export function createPiOAuthModelBinding(
  model: SubscriptionChatModel,
  piProvider: string | null,
): PiOAuthModelBinding {
  const piModel = buildPiModel({
    id: model.modelId,
    registryModelId: model.modelId,
    apiShape: model.apiShape,
    piProvider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
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
  subscription: ChatModelResolution;
  origin: string;
  mintBearer: () => string;
}): PiChatModelBindingResolution {
  if (args.subscription.subscription) {
    if ("needsReconnection" in args.subscription) return { status: "needs-reconnection" };
    const binding = createPiOAuthModelBinding(args.subscription.model, args.model.pi_provider);
    return { status: "ready", binding };
  }
  const binding = createPiProxyModelBinding(args);
  return binding ? { status: "ready", binding } : { status: "unsupported" };
}
