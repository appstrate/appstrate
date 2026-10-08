// SPDX-License-Identifier: Apache-2.0

/**
 * What level `off` puts on the wire, restating the `off` branches of the pinned
 * `@earendil-works/pi-ai` for the API shapes the platform serves, so the catalog
 * answers without building a request. A run reaches the provider through the
 * sidecar or the llm-proxy, so only the provider and `compat` decide. A branch
 * not restated answers `undefined` ("not known"); `test/pi-reasoning-off-parity.test.ts`
 * pins parity with Pi's payloads and fails when a Pi bump reaches one.
 */

import type { ModelReasoningOff } from "@appstrate/core/model-generation";
import { piReasoningLevels } from "./pi-model.ts";
import type { Api, Model } from "./pi-sdk.ts";

type CompletionsCompat = NonNullable<Model<"openai-completions">["compat"]>;

export function piTakesReasoningOff(model: Model<Api>): boolean {
  return model.reasoning && piReasoningLevels(model).includes("off");
}

export function piReasoningOff(model: Model<Api>): ModelReasoningOff | undefined {
  if (!piTakesReasoningOff(model)) return undefined;
  const sends = sendsOffParameter(model);
  return sends === undefined ? undefined : sends ? "disables" : "unsent";
}

function sendsOffParameter(model: Model<Api>): boolean | undefined {
  switch (model.api) {
    case "anthropic-messages":
    case "openai-codex-responses":
      return true;
    case "openai-responses":
      return model.provider !== "github-copilot";
    case "mistral-conversations":
      return Boolean(model.thinkingLevelMap?.off);
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
      return onlyThinkingEnabled(compat.chatTemplateArgs) ? true : undefined;
    case "openai":
    case "ant-ling":
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

/** Pi's `detectCompat`, provider half, reduced to the two fields that decide `off`. */
function detectedCompletionsDialect({ provider }: Model<Api>) {
  const is = (...providers: string[]) => providers.includes(provider);
  const zai = is("zai", "zai-coding-cn");
  const noEffort =
    zai ||
    is("together", "ant-ling", "moonshotai", "moonshotai-cn", "cloudflare-ai-gateway", "nvidia");
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
