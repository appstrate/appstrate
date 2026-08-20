// SPDX-License-Identifier: Apache-2.0

/**
 * The platform MCP server appends a generated operation index to its
 * instructions (apps/api/src/modules/mcp/router.ts). The chat keeps that index
 * only for providers where it pays: it caches (Anthropic, OpenAI auto-prefix).
 * It is stripped for Mistral (no prompt caching).
 */

import { describe, expect, it } from "bun:test";
import { applyOperationIndexPolicy } from "../src/operation-index.ts";

const HEADING = "## Operation index";
const BASE = "You are a helpful assistant.\n\nSome MCP instructions here.";
const WITH_INDEX = `${BASE}\n\n${HEADING}\n## Agents\n- listAgents — List agents`;

describe("applyOperationIndexPolicy", () => {
  it("keeps the index for the Anthropic path (cached upstream)", () => {
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
