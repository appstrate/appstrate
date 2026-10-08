// SPDX-License-Identifier: Apache-2.0

/**
 * What reasoning level `off` puts on the wire, restating the `off` branch of
 * each request builder of the pinned `@earendil-works/pi-ai`: Pi's session
 * hands `off` to the request as no reasoning option at all, and each API then
 * sends an explicit disable or nothing. Kept synchronous and request-free so
 * the catalog can serve it; an API not restated here is "not known"
 * (`undefined`), never a failed listing. Parity with the payloads Pi really
 * builds, every registry API included, is pinned by
 * `test/pi-reasoning-off-parity.test.ts`.
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

function completionsSendsOff(model: Model<Api>): boolean {
  const compat = (model.compat ?? {}) as CompletionsCompat;
  const detected = detectedCompletionsDialect(model);
  const effortOff =
    (compat.supportsReasoningEffort ?? detected.supportsReasoningEffort) &&
    typeof model.thinkingLevelMap?.off === "string";
  switch (compat.thinkingFormat ?? detected.thinkingFormat) {
    case "zai":
    case "qwen":
    case "qwen-chat-template":
    case "deepseek":
    case "openrouter":
    case "together":
    case "string-thinking":
      return true;
    case "chat-template":
      return templateSendsOff(model, compat.chatTemplateKwargs);
    case "baseten":
      return templateSendsOff(model, compat.chatTemplateArgs) || effortOff;
    default:
      // `openai`, and `ant-ling`, whose own branch only fires on a level.
      return effortOff;
  }
}

/** Pi's `detectCompat`, reduced to the two fields that decide `off`. */
function detectedCompletionsDialect({ provider, baseUrl }: Model<Api>) {
  const is = (providers: string[], hosts: string[]) =>
    providers.includes(provider) || hosts.some((host) => baseUrl.includes(host));
  const deepseek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
  const zai = is(["zai", "zai-coding-cn"], ["api.z.ai", "open.bigmodel.cn"]);
  const together = is(["together"], ["api.together.ai", "api.together.xyz"]);
  const antLing = is(["ant-ling"], ["api.ant-ling.com"]);
  const openRouter = is(["openrouter"], ["openrouter.ai"]);
  const noEffort =
    zai ||
    together ||
    antLing ||
    is(["xai"], ["api.x.ai"]) ||
    is(["moonshotai", "moonshotai-cn"], ["api.moonshot."]) ||
    is(["cloudflare-ai-gateway"], ["gateway.ai.cloudflare.com"]) ||
    is(["nvidia"], ["integrate.api.nvidia.com"]);
  const thinkingFormat = deepseek
    ? "deepseek"
    : zai
      ? "zai"
      : together
        ? "together"
        : antLing
          ? "ant-ling"
          : openRouter
            ? "openrouter"
            : "openai";
  return { thinkingFormat, supportsReasoningEffort: !noEffort };
}

/** Whether a chat-template value survives Pi's `resolveChatTemplateKwargValue` at `off`. */
function templateSendsOff(model: Model<Api>, values: Record<string, unknown> = {}): boolean {
  return Object.values(values).some((value) => {
    if (typeof value !== "object" || value === null) return value !== undefined;
    const variable = value as { omitWhenOff?: boolean; $var?: string };
    if (variable.omitWhenOff) return false;
    if (variable.$var === "thinking.enabled") return true;
    if (variable.$var === "thinking.budget") return false;
    return typeof model.thinkingLevelMap?.off === "string";
  });
}
