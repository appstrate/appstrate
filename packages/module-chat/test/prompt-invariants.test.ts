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
    expect(SYSTEM_PROMPT).toMatch(/prefer calling `run_and_wait` directly/);
    expect(SYSTEM_PROMPT).toMatch(/runAgent.*runInline.*remain available/);
    expect(SYSTEM_PROMPT).toContain("intentionally need fire-and-forget semantics");
    expect(SYSTEM_PROMPT).toContain("never fabricate it");
  });

  it("gives every inline run a task-specific human identity", () => {
    expect(SYSTEM_PROMPT).toContain("Give EVERY inline run a task-specific identity");
    expect(SYSTEM_PROMPT).toContain("manifest.display_name");
    expect(SYSTEM_PROMPT).toContain("describes the exact action or outcome of THIS run");
    expect(SYSTEM_PROMPT).toContain('"display_name": "Analyse des 3 derniers e-mails"');
    expect(SYSTEM_PROMPT).not.toContain('"name": "@inline/one-shot"');
  });

  it("keeps inline manifests concise while allowing exact complete overrides", () => {
    expect(SYSTEM_PROMPT).toContain("PARTIAL canonical AFPS agent");
    expect(SYSTEM_PROMPT).toMatch(/Defaults apply ONLY to absent top-level fields/);
    expect(SYSTEM_PROMPT).toContain("runtime_tools: []");
    expect(SYSTEM_PROMPT).toMatch(/override EVERY field/);
    expect(SYSTEM_PROMPT).toContain("complete strict `output.schema`");
  });

  it("keeps the fan-in-by-reference rule (context_files, never a copy)", () => {
    expect(SYSTEM_PROMPT).toContain("context_files");
    // The "exact shape" line is where the model copies argument NAMES from, so
    // it must list the two that carry a file and no retired one: `config` died
    // with #1179, and `run-and-wait-client` builds the launch body from an
    // allowlist — an argument under any other name is dropped before the HTTP
    // call, so the run starts with no file and nothing reports it.
    expect(SYSTEM_PROMPT).toContain('{ kind:"inline", manifest, prompt, input?, context_files? }');
    expect(SYSTEM_PROMPT).not.toContain("prompt, config?");
    expect(SYSTEM_PROMPT).toMatch(/NEVER paste a previous run's content/);
    // The reason is load-bearing: a rule with a reason survives paraphrase.
    expect(SYSTEM_PROMPT).toMatch(/retyped by a model/);
  });

  it("reads file content directly before considering a run", () => {
    expect(SYSTEM_PROMPT).toMatch(/call `read_file` first/);
    expect(SYSTEM_PROMPT).toMatch(/answer directly from that content/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT launch a run merely to read or analyse it/);
    expect(SYSTEM_PROMPT).toMatch(/metadata only or binary\/blob data/);
    expect(SYSTEM_PROMPT).toMatch(/When a run is justified.*`context_files`/s);
  });

  it("keeps the fan-out deliverable contract (file in outputs/ AND a short output)", () => {
    expect(SYSTEM_PROMPT).toContain("outputs/<topic>.md");
    expect(SYSTEM_PROMPT).toMatch(/short summary naming that file/);
  });

  it("requires descriptive filenames that survive outside the run context", () => {
    expect(SYSTEM_PROMPT).toContain(
      "remain understandable after it is downloaded outside this run",
    );
    expect(SYSTEM_PROMPT).toContain("analyse-concurrents-restaurants-lyon.md");
    expect(SYSTEM_PROMPT).toMatch(/NEVER use context-free names/);
    expect(SYSTEM_PROMPT).not.toContain("outputs/report.md");
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

  it("drops the stale claim that a prompt-pasted appfile:// URI gives no access", () => {
    // `context_files` made this half-false;
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

  it("keeps the block free of standing instructions — they belong to SYSTEM_PROMPT", () => {
    // Everything the model must DO with the context is a constant, so it lives in
    // the static prompt. The block renders data only; the sole exception is the
    // reply-language line, which is parameterised by the `X-Chat-Locale` header.
    const out = formatCallerContext({
      user: { name: "Ada" },
      org: { role: "member" },
      connections: [{ integration_id: "@appstrate/gmail", name: "Gmail", source: "own" }],
      agents: [{ package_id: "@appstrate/triage", takes_input: false }],
      agents_truncated: true,
      skills: [{ package_id: "@appstrate/web-research", version: "1.2.0" }],
      skills_truncated: true,
    });
    // Gone from the block…
    for (const imperative of [
      "Use the `@scope/name` id verbatim",
      "Prefer running an existing agent",
      "dependencies.skills",
      'operation_id: "listAgents"',
      'operation_id: "listSkills"',
      "Use this to resolve relative dates",
      "More agents are available",
      "More skills are available",
    ]) {
      expect(out).not.toContain(imperative);
    }
    // …and standing in the static prompt instead.
    for (const imperative of [
      "Use the current date to resolve relative dates",
      "Use every `@scope/name` id verbatim",
      "Prefer running an existing agent over doing the work inline",
      "declare it under the agent manifest's `dependencies.skills`",
      '`operation_id: "listAgents"` or `"listSkills"`',
      "call `listRuns` (newest first)",
    ]) {
      expect(SYSTEM_PROMPT).toContain(imperative);
    }
  });
});
