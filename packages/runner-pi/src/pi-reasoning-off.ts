// SPDX-License-Identifier: Apache-2.0

/**
 * What reasoning level `off` puts on the wire, restating the `off` branch of
 * each request builder of the pinned `@earendil-works/pi-ai`: Pi's session
 * hands `off` to the request as no reasoning option at all, and each API then
 * sends an explicit disable or nothing. Kept synchronous and request-free so
 * the catalog can serve it. It answers for the model as a run builds it: runs
 * reach the provider through the sidecar or the llm-proxy, so the upstream URL
 * never matters and only the provider and `compat` decide. Only the branches
 * Pi's registry reaches are restated; anything else (an API, a chat-completions
 * thinking format, template arguments) is "not known" (`undefined`), never a
 * failed listing. Parity with the payloads Pi really builds is pinned by
 * `test/pi-reasoning-off-parity.test.ts`, which fails on a Pi bump that
 * reaches an unrestated branch.
 */

import type { ModelReasoningOff } from "@appstrate/core/model-generation";
import { piReasoningLevels } from "./pi-model.ts";
import type { Api, Model } from "./pi-sdk.ts";

type CompletionsCompat = NonNullable<Model<"openai-completions">["compat"]>;

export function piReasoningOff(model: Model<Api>): ModelReasoningOff | undefined {
  if (!model.reasoning || !piReasoningLevels(model).includes("off")) return undefined;
  const sends = sendsOffParameter(model);
  return sends === undefined ? undefined : sends ? "disables" : "unsent";
}

// `thinkingLevelMap.off` is never null below: Pi refuses `off` then.
function sendsOffParameter(model: Model<Api>): boolean | undefined {
  switch (model.api) {
    case "anthropic-messages":
    case "azure-openai-responses":
    case "openai-codex-responses":
    case "google-generative-ai":
    case "google-vertex":
      return true;
    case "openai-responses":
      return model.provider !== "github-copilot";
    case "mistral-conversations":
      // `reasoning_effort` comes from the map; `prompt_mode` is only ever sent on.
      return Boolean(model.thinkingLevelMap?.off);
    case "bedrock-converse-stream":
    case "pi-messages":
      return false;
    case "openai-completions":
      return completionsSendsOff(model);
    default:
      return undefined;
  }
}

function completionsSendsOff(model: Model<Api>): boolean | undefined {
  const compat = (model.compat ?? {}) as CompletionsCompat;
  const detected = detectedCompletionsDialect(model);
  switch (compat.thinkingFormat ?? detected.thinkingFormat) {
    case "zai":
    case "qwen":
    case "deepseek":
    case "openrouter":
    case "together":
      return true;
    case "baseten":
      // `enable_thinking: false`: the only arguments Pi's records declare.
      return onlyThinkingEnabled(compat.chatTemplateArgs) ? true : undefined;
    case "openai":
    case "ant-ling": // its own branch only fires on a level
      return (
        (compat.supportsReasoningEffort ?? detected.supportsReasoningEffort) &&
        typeof model.thinkingLevelMap?.off === "string"
      );
    default:
      return undefined;
  }
}

function onlyThinkingEnabled(values: Record<string, unknown> = {}): boolean {
  const entries = Object.values(values);
  return (
    entries.length > 0 &&
    entries.every((value) => Bun.deepEquals(value, { $var: "thinking.enabled" }))
  );
}

/**
 * Pi's `detectCompat`, reduced to the two fields that decide `off` and to its
 * provider half: behind the proxy no upstream host is ever matched.
 */
function detectedCompletionsDialect({ provider }: Model<Api>) {
  const is = (...providers: string[]) => providers.includes(provider);
  const zai = is("zai", "zai-coding-cn");
  const noEffort =
    zai ||
    is("together", "ant-ling", "xai", "moonshotai", "moonshotai-cn") ||
    is("cloudflare-ai-gateway", "nvidia");
  const thinkingFormat = is("deepseek")
    ? "deepseek"
    : zai
      ? "zai"
      : is("together")
        ? "together"
        : is("ant-ling")
          ? "ant-ling"
          : is("openrouter")
            ? "openrouter"
            : "openai";
  return { thinkingFormat, supportsReasoningEffort: !noEffort };
}
