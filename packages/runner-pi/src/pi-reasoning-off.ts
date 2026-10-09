// SPDX-License-Identifier: Apache-2.0

/**
 * What level `off` puts on the wire, restating the pinned `@earendil-works/pi-ai`
 * for the shapes a provider can declare. Runs reach the provider through the
 * sidecar or the llm-proxy, so only the provider and `compat` decide. Anything
 * production does not build is `undefined`: the parity test pins the bundled
 * set, and the catalog build refuses a record whose derived `off` is not observed.
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
    case "openai-completions":
      return completionsSendsOff(model);
    default:
      return undefined;
  }
}

function completionsSendsOff(model: Model<Api>): boolean | undefined {
  switch (
    (model.compat as CompletionsCompat | undefined)?.thinkingFormat ??
    detectedFormat(model)
  ) {
    case "zai":
    case "qwen":
    case "deepseek":
    case "openrouter":
    case "together":
    case "baseten":
      return true;
    case "openai":
      return typeof model.thinkingLevelMap?.off === "string";
    default:
      return undefined;
  }
}

/** Pi's `detectCompat` thinking format, by provider. */
function detectedFormat({ provider }: Model<Api>): string {
  if (provider === "deepseek") return "deepseek";
  if (provider === "zai" || provider === "zai-coding-cn") return "zai";
  if (provider === "together") return "together";
  if (provider === "openrouter") return "openrouter";
  return "openai";
}
