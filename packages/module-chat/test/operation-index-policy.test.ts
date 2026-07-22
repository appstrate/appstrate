// SPDX-License-Identifier: Apache-2.0

/**
 * The platform MCP server appends a generated operation index to its
 * instructions (apps/api/src/modules/mcp/router.ts). The chat keeps that index
 * only for providers where it pays: it caches (Claude SDK, Anthropic via
 * cache_control, OpenAI auto-prefix). It is stripped for Mistral (no prompt
 * caching).
 */

import { describe, expect, it } from "bun:test";
import { CHAT_FINAL_STEP_SYSTEM_PROMPT } from "@appstrate/core/chat-turn-metadata";
import {
  aiSdkCachedSystemMessage,
  applyOperationIndexPolicy,
  prepareAiSdkChatStep,
} from "../src/chat-stream.ts";

const HEADING = "## Operation index";
const BASE = "You are a helpful assistant.\n\nSome MCP instructions here.";
const WITH_INDEX = `${BASE}\n\n${HEADING}\n## Agents\n- listAgents — List agents`;

describe("applyOperationIndexPolicy", () => {
  it("keeps the index for the Anthropic API-key path (cached via cache_control)", () => {
    expect(applyOperationIndexPolicy(WITH_INDEX, "anthropic-messages")).toBe(WITH_INDEX);
  });

  it("keeps the index for OpenAI completions (auto prefix cache)", () => {
    expect(applyOperationIndexPolicy(WITH_INDEX, "openai-completions")).toBe(WITH_INDEX);
  });

  it("strips the index for Mistral (no prompt caching)", () => {
    const out = applyOperationIndexPolicy(WITH_INDEX, "mistral-conversations");
    expect(out).toBe(BASE);
    expect(out).not.toContain(HEADING);
  });

  it("is a no-op when there is no index to strip", () => {
    expect(applyOperationIndexPolicy(BASE, "mistral-conversations")).toBe(BASE);
  });
});

describe("prepareAiSdkChatStep", () => {
  const modelMessages = [{ role: "user", content: "hello" }] as Parameters<
    typeof prepareAiSdkChatStep
  >[0]["modelMessages"];

  it("keeps ordinary steps unchanged", () => {
    let reached = false;
    const step = prepareAiSdkChatStep({
      stepNumber: 14,
      system: BASE,
      modelMessages,
      markToolStepBudgetReached: () => {
        reached = true;
      },
    });

    expect(step).toBeUndefined();
    expect(reached).toBe(false);
  });

  it("disables tools and overrides instructions on the reserved final step", () => {
    let reached = false;
    const step = prepareAiSdkChatStep({
      stepNumber: 15,
      system: BASE,
      modelMessages,
      markToolStepBudgetReached: () => {
        reached = true;
      },
    });

    expect(reached).toBe(true);
    // The final step swaps the base instructions for the appended final-step
    // directive (cache-controlled) and resets `messages` to the original history
    // — no system message rides inside `messages` any more (instructions carries
    // it, prepended by ai@7 as a system message).
    expect(step).toEqual({
      activeTools: [],
      toolChoice: "none",
      instructions: aiSdkCachedSystemMessage(`${BASE}\n\n${CHAT_FINAL_STEP_SYSTEM_PROMPT}`),
      messages: [...modelMessages],
    });
  });

  it("marks the cache-controlled instructions object as Anthropic-cacheable", () => {
    expect(aiSdkCachedSystemMessage(BASE)).toEqual({
      role: "system",
      content: BASE,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});
