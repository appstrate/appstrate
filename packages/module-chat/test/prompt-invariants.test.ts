// SPDX-License-Identifier: Apache-2.0

/**
 * Guard the chat system prompt's behavioral invariants against silent drift.
 * The persona is assembled by `buildSystemPrompt` from the turn's grants; these substring checks pin the
 * rules the product depends on (single sub-agent for chained actions, no run
 * metrics in replies, prefer available integrations) so a rewrite that drops
 * one fails loudly instead of degrading agent behavior in production.
 */

import { describe, expect, it } from "bun:test";
import { buildSystemPrompt, formatCallerContext, normalizeChatLocale } from "../src/prompt.ts";
import { DEFAULT_SKILL_DISCOVERY } from "../src/skills.ts";

/**
 * The ONE activation door's operationId (`POST /api/spaces/{spaceId}/packages`,
 * `apps/api/src/openapi/paths/spaces.ts`). Pinned here rather than imported:
 * `verify:module-isolation` forbids a module reaching into the API workspace.
 */
const ACTIVATION_OPERATION_ID = "activatePackage";

/** The full persona; the reduced one has its own block at the end. */
const FULL = buildSystemPrompt({
  canComposeInline: true,
  canAuthorAgents: true,
  skillDiscovery: DEFAULT_SKILL_DISCOVERY,
});

describe("full persona invariants", () => {
  it("keeps the single-sub-agent rule for chained external actions", () => {
    expect(FULL).toContain("compose ONE sub-agent");
    expect(FULL).toContain("do NOT chain one run per action");
  });

  it("keeps the no-run-metrics rule", () => {
    expect(FULL).toContain("Never quote run metrics");
    expect(FULL).toContain("duration, cost, token usage");
  });

  it("keeps the available-integrations-by-default rule for context research", () => {
    expect(FULL).toContain("default to the integrations already available");
    expect(FULL).toContain("connected ones first");
  });

  it("keeps the run_and_wait grounding (result is the deliverable)", () => {
    expect(FULL).toContain("run_and_wait");
    expect(FULL).toMatch(/prefer calling `run_and_wait` directly/);
    expect(FULL).toMatch(/runAgent.*runInline.*remain available/);
    expect(FULL).toContain("intentionally need fire-and-forget semantics");
    expect(FULL).toContain("never fabricate it");
  });

  it("gives every inline run a task-specific human identity", () => {
    expect(FULL).toContain("Give EVERY inline run a task-specific identity");
    expect(FULL).toContain("manifest.display_name");
    expect(FULL).toContain("describes the exact action or outcome of THIS run");
    expect(FULL).toContain('"display_name": "Analyse des 3 derniers e-mails"');
    expect(FULL).not.toContain('"name": "@inline/one-shot"');
  });

  it("keeps inline manifests concise while allowing exact complete overrides", () => {
    expect(FULL).toContain("PARTIAL canonical AFPS agent");
    expect(FULL).toMatch(/Defaults apply ONLY to absent top-level fields/);
    expect(FULL).toContain("runtime_tools: []");
    expect(FULL).toMatch(/override EVERY field/);
    expect(FULL).toContain("complete strict `output.schema`");
  });

  it("keeps the fan-in-by-reference rule (context_files, never a copy)", () => {
    expect(FULL).toContain("context_files");
    // The "exact shape" line is where the model copies argument NAMES from, so
    // it must list the two that carry a file and no retired one: `config` died
    // with #1179, and `run-and-wait-client` builds the launch body from an
    // allowlist — an argument under any other name is dropped before the HTTP
    // call, so the run starts with no file and nothing reports it.
    expect(FULL).toContain('{ kind:"inline", manifest, prompt, input?, context_files? }');
    expect(FULL).not.toContain("prompt, config?");
    expect(FULL).toMatch(/NEVER paste a previous run's content/);
    // The reason is load-bearing: a rule with a reason survives paraphrase.
    expect(FULL).toMatch(/retyped by a model/);
  });

  it("reads file content directly before considering a run", () => {
    expect(FULL).toMatch(/call `read_file` first/);
    expect(FULL).toMatch(/answer directly from that content/);
    expect(FULL).toMatch(/do NOT launch a run merely to read or analyse it/);
    expect(FULL).toMatch(/metadata only or binary\/blob data/);
    expect(FULL).toMatch(/When a run is justified.*`context_files`/s);
  });

  it("keeps the fan-out deliverable contract (file in outputs/ AND a short output)", () => {
    expect(FULL).toContain("outputs/<topic>.md");
    expect(FULL).toMatch(/short summary naming that file/);
  });

  it("requires descriptive filenames that survive outside the run context", () => {
    expect(FULL).toContain("remain understandable after it is downloaded outside this run");
    expect(FULL).toContain("analyse-concurrents-restaurants-lyon.md");
    expect(FULL).toMatch(/NEVER use context-free names/);
    expect(FULL).not.toContain("outputs/report.md");
  });

  it("keeps the sub-agent effort ceiling (cap, stop criterion, output last)", () => {
    expect(FULL).toMatch(/at most 3 searches/);
    expect(FULL).toMatch(/stop criterion/);
    expect(FULL).toMatch(/mandatory last action/);
  });

  it("keeps incremental delivery (synthesis written before the next step)", () => {
    expect(FULL).toMatch(/BEFORE launching the next step/);
  });

  it("routes integration_not_active to activation, never to a retry", () => {
    // Retrying the run or re-running the connect flow can never clear a 412:
    // connecting is personal, activating is space-wide. Activation IS
    // reachable, and RBAC decides who may call it — an admin fixes it in one
    // step, a member gets a 403 and is told to ask one. Nothing in the chat
    // pre-computes that right: quoting the operation instead of asserting the
    // outcome is what keeps this honest for both roles.
    expect(FULL).toContain("integration_not_active");
    expect(FULL).toMatch(/do NOT re-run and do NOT restart the connect flow/);
    expect(FULL).toContain(`operation_id: "${ACTIVATION_OPERATION_ID}"`);
    expect(FULL).toMatch(/administrator must activate/);
    // The remedy names a `spaceId` path param, which is only answerable
    // because the context block renders the current space.
    expect(FULL).toContain('path_params: { "spaceId"');
    expect(FULL).toContain('body: { "packageId"');
  });

  it("names an activation operation the platform actually registers", () => {
    // The persona used to name `activateIntegration`, which has never existed:
    // a model following it burned a turn on `search_operations` and guessed.
    // The real door is `activatePackage`, `POST /api/spaces/{spaceId}/packages`
    // (apps/api/src/openapi/paths/spaces.ts). A module test cannot import the
    // API workspace (`verify:module-isolation`), so the id is pinned as a
    // constant here and the negative below catches the name that never was.
    expect(FULL).not.toContain("activateIntegration");
  });

  it("teaches loading a skill through getSkill, one at a time, before acting", () => {
    // The whole point of phase 2: the chat could NAME skills and never use one.
    expect(FULL).toContain("guides for YOU");
    expect(FULL).toContain('`operation_id: "getSkill"`');
    expect(FULL).toContain("LOAD IT BEFORE acting");
    expect(FULL).toContain("KEEP the leading `@`");
    expect(FULL).toContain("Load ONE at a time");
    expect(FULL).toContain("Never reload a skill whose `content` already appears");
    expect(FULL).toContain("`(pinned)` is one the user chose for this conversation");
  });

  it("teaches that an injected `[Skill … loaded]` block IS the skill's content", () => {
    // Phase 4: a `/skill` mention puts the body in the USER TURN TEXT. Without
    // this sentence the model reads a block it has no name for and re-fetches
    // the same skill through `getSkill` — paying for the body twice.
    expect(FULL).toContain("[Skill @scope/name … loaded — follow these instructions]");
    expect(FULL).toContain("IS that skill's content");
    expect(FULL).toContain("never call `getSkill` for that skill again");
  });

  it("teaches the loading rules whatever the turn may author", () => {
    // Skills are the assistant's own guides now — not something only an author
    // of agents has a use for.
    const REDUCED = buildSystemPrompt({
      canComposeInline: false,
      canAuthorAgents: false,
      skillDiscovery: DEFAULT_SKILL_DISCOVERY,
    });
    expect(REDUCED).toContain('`operation_id: "getSkill"`');
    expect(REDUCED).toContain("guides for YOU");
  });

  it("flips the catalogue sentence with the discovery mode", () => {
    const auto = buildSystemPrompt({
      canComposeInline: true,
      canAuthorAgents: true,
      skillDiscovery: "auto",
    });
    const onDemand = buildSystemPrompt({
      canComposeInline: true,
      canAuthorAgents: true,
      skillDiscovery: "on_demand",
    });
    const manual = buildSystemPrompt({
      canComposeInline: true,
      canAuthorAgents: true,
      skillDiscovery: "manual",
    });
    // `auto` IS the default mode, so it reads like the persona built with it.
    expect(auto).toBe(FULL);
    expect(auto).toContain("### Other skills in this space` is a catalogue");
    expect(onDemand).toContain("No catalogue of other skills is shown to you");
    expect(onDemand).not.toContain("is a catalogue you have not loaded");
    expect(manual).toContain("Load only the skills listed under `## Skills`");
    expect(manual).not.toContain("No catalogue of other skills is shown");
    // A mode that shows no catalogue must not send the model browsing.
    expect(manual).not.toContain("call `listSkills` to see the rest");
  });

  it("carries no trace of the retired attach-to-an-agent skills heading", () => {
    expect(FULL).not.toContain("Skills you can attach to an agent");
    expect(
      formatCallerContext({
        user: { name: "Ada" },
        org: { role: "member" },
        skills: [{ package_id: "@acme/pdf", display_name: "PDF" }],
      }),
    ).not.toContain("Skills you can attach to an agent");
  });

  it("drops the stale claim that a prompt-pasted appfile:// URI gives no access", () => {
    // `context_files` made this half-false;
    // the paragraph now points at the cheap path instead of the boilerplate.
    expect(FULL).not.toContain("does NOT give it access");
    expect(FULL).not.toContain("does NOT give access");
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

  it("keeps the block free of standing instructions — they belong to the system prompt", () => {
    // Everything the model must DO with the context lives in the persona
    // (`buildSystemPrompt`). The block renders data only; the sole exception is the
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
    // …and standing in the persona instead.
    for (const imperative of [
      "Use the current date to resolve relative dates",
      "Use every `@scope/name` id verbatim",
      "Prefer running an existing agent over doing the work inline",
      "declare it under the agent manifest's `dependencies.skills`",
      '`operation_id: "listAgents"` or `"listSkills"`',
      "call `listRuns` (newest first)",
    ]) {
      expect(FULL).toContain(imperative);
    }
  });
});

describe("the persona without inline composition", () => {
  // What a turn without `agents:write` ∧ `agents:run` is told. The platform
  // refuses the launch either way; this block is about not teaching it.
  const REDUCED = buildSystemPrompt({
    canComposeInline: false,
    canAuthorAgents: false,
    skillDiscovery: DEFAULT_SKILL_DISCOVERY,
  });
  /** `agents:write` without `agents:run`: may author agents, not compose one inline. */
  const AUTHOR_ONLY = buildSystemPrompt({
    canComposeInline: false,
    canAuthorAgents: true,
    skillDiscovery: DEFAULT_SKILL_DISCOVERY,
  });

  it("teaches no way to compose one", () => {
    expect(REDUCED).not.toContain('kind:"inline"');
    expect(REDUCED).not.toContain("PARTIAL canonical AFPS agent");
    expect(REDUCED).not.toContain("Give EVERY inline run a task-specific identity");
    expect(REDUCED).not.toContain("runInline");
  });

  it("keeps every rule that is not about composing one", () => {
    expect(REDUCED).toContain("You are Appstrate's assistant");
    expect(REDUCED).toContain("Never quote run metrics");
    expect(REDUCED).toContain("default to the integrations already available");
    expect(REDUCED).toContain("call `read_file` first");
    expect(REDUCED).toContain('{ kind:"agent", scope, name, version?, input? }');
    expect(REDUCED).toContain("Respect the user's role");
  });

  it("states the published-agent and `output` contracts once, in both personas", () => {
    for (const shared of [
      "input schema is a versioned contract the platform never rewrites",
      "under one of the agent's DECLARED file fields",
      "is plain data for YOU — it never becomes a file the user can open or download",
      "`files` list",
    ]) {
      expect(FULL).toContain(shared);
      expect(REDUCED).toContain(shared);
      expect(FULL.split(shared)).toHaveLength(2);
    }
  });

  it("names no argument `run_and_wait` only takes for an inline run", () => {
    for (const argument of ["context_files", "`manifest`", "`prompt`"]) {
      expect(FULL).toContain(argument);
      expect(REDUCED).not.toContain(argument);
    }
  });

  it("does not offer composing one as the fallback for an unrunnable draft", () => {
    expect(FULL).toContain("offer to compose an inline agent instead");
    expect(REDUCED).not.toContain("offer to compose an inline agent instead");
    expect(REDUCED).toContain("there is no other way to run it");
  });

  it("says to stop when no agent matches, without creating or modifying one", () => {
    expect(REDUCED).toContain("when no existing agent matches, say so plainly and stop");
    expect(REDUCED).toContain("Do not create or modify an agent");
    expect(FULL).not.toContain("when no existing agent matches");
    expect(FULL).not.toContain("Do not create or modify an agent");
  });

  it("forbids authoring and teaches skill declaration on `agents:write` alone, not on composing", () => {
    const skills = "Skills are not run on their own";
    expect(FULL).toContain(skills);
    expect(REDUCED).not.toContain(skills);
    // A caller who may write but not run: no inline, yet nothing forbids authoring.
    expect(AUTHOR_ONLY).toContain(skills);
    expect(AUTHOR_ONLY).not.toContain("Do not create or modify an agent");
    expect(AUTHOR_ONLY).not.toContain('kind:"inline"');
    // Configuring or activating stays open (`agents:configure`); "manage" would not.
    expect(FULL).toContain("manage agents");
    expect(REDUCED).not.toContain("manage agents");
    expect(REDUCED).toContain("configure or activate agents");
    // Manifest fields mean nothing to a turn that may not author an agent.
    expect(FULL).toContain("`dependencies.integrations`");
    expect(REDUCED).not.toContain("dependencies.");
  });

  it("is materially shorter — the point is not to pay for what is refused", () => {
    expect(FULL.length - REDUCED.length).toBeGreaterThan(3_000);
  });
});
