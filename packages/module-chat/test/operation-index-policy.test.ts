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

  const NOW = 1_800_000_000_000;
  const DEADLINE = NOW + 4 * 60_000 + 12_000; // 4m12s left

  it("keeps ordinary steps on the base instructions, with the budget in a trailing block", () => {
    let reached = false;
    const step = prepareAiSdkChatStep({
      stepNumber: 14,
      system: BASE,
      modelMessages,
      markToolStepBudgetReached: () => {
        reached = true;
      },
      turnDeadlineAt: DEADLINE,
      now: NOW,
    });

    expect(reached).toBe(false);
    // No tool restriction, no messages override — only the instructions gain the
    // per-step budget block.
    expect(Object.keys(step)).toEqual(["instructions"]);
    // Block 0 is the UNCHANGED cached base prompt: the Anthropic cache
    // breakpoint rides it, so the prefix stays byte-identical every step.
    expect(step.instructions[0]).toEqual(aiSdkCachedSystemMessage(BASE));
    // Block 1 is the varying part, deliberately WITHOUT cacheControl — it sits
    // after the breakpoint and cannot invalidate the cached prefix.
    expect(step.instructions[1]?.providerOptions).toBeUndefined();
    expect(step.instructions[1]?.content).toContain("4m12s");
    expect(step.instructions[1]?.content).toContain("step 14/16");
  });

  it("disables tools and moves the final-step directive into the trailing block", () => {
    let reached = false;
    const step = prepareAiSdkChatStep({
      stepNumber: 15,
      system: BASE,
      modelMessages,
      markToolStepBudgetReached: () => {
        reached = true;
      },
      turnDeadlineAt: DEADLINE,
      now: NOW,
    });

    expect(reached).toBe(true);
    // The final step disables tools and resets `messages` to the original
    // history — no system message rides inside `messages` (instructions carries
    // it, prepended by ai@7 as system messages).
    expect(step).toEqual({
      activeTools: [],
      toolChoice: "none",
      instructions: [
        aiSdkCachedSystemMessage(BASE),
        {
          role: "system",
          content: expect.stringContaining(CHAT_FINAL_STEP_SYSTEM_PROMPT) as unknown as string,
        },
      ],
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
