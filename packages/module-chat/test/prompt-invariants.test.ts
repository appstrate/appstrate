// SPDX-License-Identifier: Apache-2.0

/**
 * Guard the chat system prompt's behavioral invariants against silent drift.
 * The prompt is a single literal edited by hand; these substring checks pin the
 * rules the product depends on (single sub-agent for chained actions, no run
 * metrics in replies, prefer available integrations) so a rewrite that drops
 * one fails loudly instead of degrading agent behavior in production.
 */

import { describe, expect, it } from "bun:test";
import { SYSTEM_PROMPT, formatCallerContext, normalizeChatLocale } from "../src/prompt.ts";

describe("SYSTEM_PROMPT invariants", () => {
  it("keeps the single-sub-agent rule for chained external actions", () => {
    expect(SYSTEM_PROMPT).toContain("compose ONE sub-agent");
    expect(SYSTEM_PROMPT).toContain("do NOT chain one run per action");
  });

  it("keeps the no-run-metrics rule", () => {
    expect(SYSTEM_PROMPT).toContain("Never quote run metrics");
    expect(SYSTEM_PROMPT).toContain("duration, cost, token usage");
  });

  it("keeps the available-integrations-by-default rule for context research", () => {
    expect(SYSTEM_PROMPT).toContain("default to the integrations already available");
    expect(SYSTEM_PROMPT).toContain("connected ones first");
  });

  it("keeps the run_and_wait grounding (result is the deliverable)", () => {
    expect(SYSTEM_PROMPT).toContain("run_and_wait");
    expect(SYSTEM_PROMPT).toContain("never fabricate it");
  });

  it("keeps the assistant-skills load-before-acting posture", () => {
    expect(SYSTEM_PROMPT).toContain("assistant skills");
    expect(SYSTEM_PROMPT).toContain('`operation_id: "getSkill"`');
    expect(SYSTEM_PROMPT).toContain("load it BEFORE acting");
  });
});

describe("normalizeChatLocale", () => {
  it("keeps a supported two-letter code and lowers/strips regional subtags", () => {
    expect(normalizeChatLocale("en")).toBe("en");
    expect(normalizeChatLocale("en-US")).toBe("en");
    expect(normalizeChatLocale("FR")).toBe("fr");
  });

  it("falls back to fr on absent or malformed input (header is client-supplied)", () => {
    expect(normalizeChatLocale(undefined)).toBe("fr");
    expect(normalizeChatLocale("")).toBe("fr");
    expect(normalizeChatLocale("english")).toBe("fr");
    expect(normalizeChatLocale("<script>")).toBe("fr");
  });
});

describe("caller-context prompt hygiene", () => {
  const identity = { user: { name: "Ada" }, org: { role: "member" } };

  it("renders the forwarded locale in the reply-language line", () => {
    const out = formatCallerContext(identity, { locale: "en-US" });
    expect(out).toContain("Reply in the user's language (en)");
  });

  it("defaults the reply language to fr without a locale", () => {
    expect(formatCallerContext(identity)).toContain("Reply in the user's language (fr)");
  });

  it("rounds the grounding timestamp to the minute (prompt prefix-cache stability)", () => {
    const out = formatCallerContext(identity);
    expect(out).toMatch(/Current date and time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z \(UTC\)/);
  });
});
