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

  it("keeps the fan-in-by-reference rule (context_documents, never a copy)", () => {
    expect(SYSTEM_PROMPT).toContain("context_documents");
    expect(SYSTEM_PROMPT).toMatch(/NEVER paste a previous run's content/);
    // The reason is load-bearing: a rule with a reason survives paraphrase.
    expect(SYSTEM_PROMPT).toMatch(/retyped by a model/);
  });

  it("keeps the fan-out deliverable contract (file in outputs/ AND a short output)", () => {
    expect(SYSTEM_PROMPT).toContain("outputs/<topic>.md");
    expect(SYSTEM_PROMPT).toMatch(/short summary naming that file/);
  });

  it("keeps the sub-agent effort ceiling (cap, stop criterion, output last)", () => {
    expect(SYSTEM_PROMPT).toMatch(/at most 3 searches/);
    expect(SYSTEM_PROMPT).toMatch(/stop criterion/);
    expect(SYSTEM_PROMPT).toMatch(/mandatory last action/);
  });

  it("keeps incremental delivery (synthesis written before the next step)", () => {
    expect(SYSTEM_PROMPT).toMatch(/BEFORE launching the next step/);
  });

  it("routes integration_not_active to activation, never to a retry", () => {
    // Retrying the run or re-running the connect flow can never clear a 412:
    // connecting is personal, activating is application-wide. Activation IS
    // reachable (`activateIntegration` is in the platform's operation surface),
    // and RBAC decides who may call it — an admin fixes it in one step, a member
    // gets a 403 and is told to ask one. Nothing in the chat pre-computes that
    // right: quoting the operation instead of asserting the outcome is what
    // keeps this honest for both roles.
    expect(SYSTEM_PROMPT).toContain("integration_not_active");
    expect(SYSTEM_PROMPT).toMatch(/do NOT re-run and do NOT restart the connect flow/);
    expect(SYSTEM_PROMPT).toContain("activateIntegration");
    expect(SYSTEM_PROMPT).toMatch(/administrator must activate/);
  });

  it("drops the stale claim that a prompt-pasted document:// URI gives no access", () => {
    // `context_documents` + the platform-side auto-repair made this half-false;
    // the paragraph now points at the cheap path instead of the boilerplate.
    expect(SYSTEM_PROMPT).not.toContain("does NOT give it access");
    expect(SYSTEM_PROMPT).not.toContain("does NOT give access");
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
