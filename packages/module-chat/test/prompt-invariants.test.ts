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
import { turnCapabilities } from "../src/capabilities.ts";
import { DEFAULT_SKILL_SELECTION } from "../src/skills.ts";

/** The turn's capabilities, from a permission set a role can actually hold. */
function caps(permissions: readonly string[]) {
  return turnCapabilities((permission) => permissions.includes(permission));
}

/** Build a persona from a permission set, so every one below is reachable. */
function promptFor(permissions: readonly string[]): string {
  return buildSystemPrompt(caps(permissions));
}

/** The transport floor plus the dispatching tool — nothing acts without both. */
const MCP = ["mcp:read", "mcp:invoke"];
/** A builder as the platform grants it. */
const BUILDER = [...MCP, "agents:read", "agents:run", "agents:write", "runs:read", "skills:read"];

/** The full persona; the reduced ones have their own blocks at the end. */
const FULL = promptFor(BUILDER);
/** Builder minus `agents:write`: runs existing agents, composes and authors nothing. */
const REDUCED = promptFor(BUILDER.filter((permission) => permission !== "agents:write"));
/** May author an agent, may not launch one. */
const NO_RUNS_AUTHOR = promptFor([...MCP, "agents:write", "skills:read"]);

/** `formatCallerContext` options for a builder turn with the default skill selection. */
const CONTEXT_OPTS = {
  capabilities: caps(BUILDER),
  rolePreview: false,
  spaceRole: "builder",
  permissions: ["agents:read", "mcp:invoke"],
  skills: DEFAULT_SKILL_SELECTION,
};

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
    // Retrying the run or re-running the connect flow can never clear a 409:
    // connecting is personal, activating is per space. The persona names the
    // real catalog operation with its path and body, because the model is told
    // never to guess an operationId. `activatePackage` is decided in the space
    // its path names, so its 403 carries the route's own error, never the
    // caller-space `required_permissions` enrichment; claiming it would be false.
    expect(FULL).toContain("integration_not_active");
    expect(FULL).toMatch(/do NOT re-run and do NOT restart the connect flow/);
    expect(FULL).toContain("`activatePackage`");
    expect(FULL).toContain("`POST /api/spaces/{spaceId}/packages`");
    expect(FULL).toContain('{ "packageId": "<that integration id>" }');
    expect(FULL).not.toContain("activateIntegration");
    expect(FULL).toMatch(/report the refusal with its error and stop/);
    expect(FULL).not.toMatch(/the 403 names the permission it required/);
  });

  it("teaches loading a skill through getSkill, one at a time, before acting", () => {
    expect(FULL).toContain("guides for YOU");
    expect(FULL).toContain('`operation_id: "getSkill"`');
    expect(FULL).toContain("LOAD IT BEFORE acting");
    expect(FULL).toContain("KEEP the leading `@`");
    expect(FULL).toContain("Load ONE at a time");
    expect(FULL).toContain("Never call `getSkill` for a skill whose content already appears");
    // The injected ones are already loaded; `getSkill` is for a skill listed by name.
    expect(FULL).toContain("One shown in full, inside a `<skill>` tag, is already loaded");
  });

  it("names the same heading the context block renders", () => {
    const block = formatCallerContext(
      {
        user: { name: "Ada" },
        skills: [{ packageId: "@acme/mine" }],
      },
      CONTEXT_OPTS,
    );
    expect(block).toContain("## Skills");
    expect(FULL).toContain("`## Skills`");
  });

  it("teaches the loading rules whatever the turn may author", () => {
    const readerOnly = promptFor([...MCP, "skills:read"]);
    expect(readerOnly).toContain('`operation_id: "getSkill"`');
    expect(readerOnly).toContain("guides for YOU");
  });

  it("names `listSkills` for an unlisted request here, and for a truncated list only in the list bullet", () => {
    expect(FULL).toContain("Call `listSkills` only when the user asks for a skill you do not see.");
    expect(FULL.split("listSkills")).toHaveLength(3);
  });

  it("teaches nothing about skills to a turn without `skills:read`", () => {
    const noSkills = promptFor(BUILDER.filter((permission) => permission !== "skills:read"));
    for (const skillRule of [
      "getSkill",
      "listSkills",
      "## Skills",
      "Skills are not run on their own",
      "attach it under `dependencies.skills`",
      "and the skills available",
      "in `dependencies.skills`",
    ]) {
      expect(FULL).toContain(skillRule);
      expect(noSkills).not.toContain(skillRule);
    }
    expect(noSkills).toContain('`operation_id: "listAgents"` for the full one');
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
    const out = formatCallerContext(identity, { ...CONTEXT_OPTS, locale: "en-US" });
    expect(out).toContain("Reply in the user's language (en)");
  });

  it("defaults the reply language to fr without a locale", () => {
    expect(formatCallerContext(identity, CONTEXT_OPTS)).toContain(
      "Reply in the user's language (fr)",
    );
  });

  it("keeps the block free of standing instructions — they belong to the system prompt", () => {
    // Everything the model must DO with the context lives in the persona
    // (`buildSystemPrompt`). The block renders data only; the sole exception is the
    // reply-language line, which is parameterised by the `X-Chat-Locale` header.
    const out = formatCallerContext(
      {
        user: { name: "Ada" },
        org: { role: "member" },
        connections: [{ integration_id: "@appstrate/gmail", name: "Gmail", source: "own" }],
        agents: [{ packageId: "@appstrate/triage", takes_input: false }],
        agents_truncated: true,
        skills: [{ packageId: "@appstrate/web-research", version: "1.2.0" }],
        skills_truncated: true,
      },
      CONTEXT_OPTS,
    );
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
    expect(REDUCED).toContain("The context lists the permissions this turn holds");
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
    // A caller who may write but not launch: no inline, yet nothing forbids
    // authoring — the reduced persona's "do not create one" line is a RUN-branch
    // sentence, so it cannot reach a turn that holds `agents:write`.
    expect(NO_RUNS_AUTHOR).toContain(skills);
    expect(NO_RUNS_AUTHOR).not.toContain("Do not create or modify an agent");
    expect(NO_RUNS_AUTHOR).not.toContain('kind:"inline"');
    // Manifest fields mean nothing to a turn that may not author an agent.
    expect(FULL).toContain("`dependencies.integrations`");
    expect(REDUCED).not.toContain("dependencies.");
  });

  it("is materially shorter — the point is not to pay for what is refused", () => {
    expect(FULL.length - REDUCED.length).toBeGreaterThan(3_000);
  });

  it("still teaches running an existing agent — the tool IS declared to it", () => {
    expect(REDUCED).toContain("run_and_wait");
    expect(REDUCED).toContain('kind:"agent"');
    expect(REDUCED).not.toContain('kind:"inline"');
  });
});

describe("the persona without agent runs", () => {
  // `run_and_wait` is declared on `mcp:invoke` ∧ launch ∧ run-read; a turn
  // missing any of the three is never shown the tool, so the persona must not
  // teach it. Absent, not contradicted: nothing says "you cannot run agents".
  const NO_RUNS = promptFor(MCP);
  /** `mcp:invoke` ∧ run-read without `agents:run`: may inspect runs, not launch. */
  const READER = promptFor([...MCP, "runs:read"]);
  /** The control this block is measured against: the same grants plus the launch. */
  const RUNNER = REDUCED;

  it("names no way to launch a run", () => {
    for (const taught of [
      "run_and_wait",
      "runAgent",
      "runInline",
      'kind:"agent"',
      'kind:"inline"',
      "listRuns",
      "outputs/",
      "integration_not_active",
      "run an agent",
    ]) {
      expect(NO_RUNS).not.toContain(taught);
      expect(NO_RUNS_AUTHOR).not.toContain(taught);
    }
  });

  it("closes on the permission list, not on a vague deference to the role", () => {
    // The context block now carries the turn's set in the `required_permissions`
    // vocabulary, so the closing rule can be joined against it.
    for (const persona of [NO_RUNS, FULL]) {
      expect(persona).toContain("The context lists the permissions this turn holds");
      expect(persona).toContain("say which permission is missing instead of attempting it");
      expect(persona).not.toContain("Respect the user's role");
    }
  });

  it("enumerates no permission-gated act — the turn's permission list is the authority", () => {
    // The permission list is the one authority always in context: the operation
    // index is stripped for the engines whose models choke on it
    // (`applyOperationIndexPolicy`), so a sentence pointing at the index points
    // at nothing there. A persona that names acts attributes them to a caller
    // whose set may not carry them: an operator asked "what can you do?"
    // answered from the prompt instead of from its tools.
    for (const enumerated of ["manage agents", "configure or activate", "schedule"]) {
      expect(NO_RUNS).not.toContain(enumerated);
      expect(FULL).not.toContain(enumerated);
    }
    for (const persona of [NO_RUNS, FULL]) {
      expect(persona).toContain(
        "If the request is a pure Appstrate operation, call that operation directly with `invoke_operation`",
      );
      expect(persona).toContain("the permissions listed in your context decide what you may call");
      expect(persona).not.toContain("the operation index in your instructions is the authority");
    }
  });

  it("contradicts nothing — no refusal is asserted in the model's place", () => {
    for (const contradiction of ["cannot run", "not allowed to run", "you may not run"]) {
      expect(NO_RUNS).not.toContain(contradiction);
    }
  });

  it("keeps every rule that is not about running", () => {
    expect(NO_RUNS).toContain("You are Appstrate's assistant");
    expect(NO_RUNS).toContain("call `read_file` first");
    expect(NO_RUNS).toContain("Never invent an operationId or argument shape");
    expect(NO_RUNS).toContain("The context lists the permissions this turn holds");
  });

  it("keeps skill authoring, which needs no run", () => {
    expect(NO_RUNS_AUTHOR).toContain("Skills are not run on their own");
    expect(NO_RUNS_AUTHOR).toContain("in `dependencies.integrations` and in `dependencies.skills`");
    expect(NO_RUNS).not.toContain("Skills are not run on their own");
    // Neither list is rendered, so the bullet about truncated lists is gone too.
    expect(NO_RUNS).not.toContain("(list truncated)");
    expect(NO_RUNS_AUTHOR).toContain("(list truncated)");
  });

  it("names the full-list operation only for a list the context renders", () => {
    // Skills are listed on reading them, agents on running: each operation is
    // named under the gate that shows its list, never under the other one.
    expect(NO_RUNS_AUTHOR).toContain('`operation_id: "listSkills"`');
    expect(NO_RUNS_AUTHOR).not.toContain("listAgents");
    const runsNoSkills = promptFor(BUILDER.filter((permission) => permission !== "skills:read"));
    expect(runsNoSkills).toContain('`operation_id: "listAgents"`');
    expect(runsNoSkills).not.toContain("listSkills");
  });

  it("lists no agent as runnable in the caller-context block", () => {
    const raw = {
      user: { name: "Ada" },
      org: { role: "member" },
      agents: [{ packageId: "@acme/triage", takes_input: false }],
    };
    expect(
      formatCallerContext(raw, {
        capabilities: caps(BUILDER),
        rolePreview: false,
        spaceRole: "builder",
        permissions: ["agents:read", "mcp:invoke"],
        skills: DEFAULT_SKILL_SELECTION,
      }),
    ).toContain("## Existing agents you can run");
    const off = formatCallerContext(raw, {
      capabilities: caps([...MCP, "agents:write"]),
      rolePreview: false,
      spaceRole: "builder",
      permissions: ["agents:read", "mcp:invoke"],
      skills: DEFAULT_SKILL_SELECTION,
    });
    expect(off).not.toContain("## Existing agents you can run");
    expect(off).not.toContain("@acme/triage");
    // The identity half survives — date and role grounding do not depend on runs.
    expect(off).toContain("You are assisting Ada");
  });

  it("keeps the run-reading rules for a turn that may inspect runs but not launch", () => {
    // Reading runs is its own grant (`mcp:invoke` ∧ run-read): the history
    // bullet and the metrics rule presuppose it, not the launch.
    expect(READER).toContain("listRuns");
    expect(READER).toContain("Never quote run metrics");
    expect(READER).not.toContain("run_and_wait");
    // Re-running is the launch half — gone with it.
    expect(READER).not.toContain("or wants to re-run something");
    expect(RUNNER).toContain("or wants to re-run something");
    // And a turn that may not read runs at all is told neither.
    expect(NO_RUNS).not.toContain("Never quote run metrics");
  });

  it("is materially shorter than the persona that may run", () => {
    expect(RUNNER.length - NO_RUNS.length).toBeGreaterThan(4_000);
  });
});

describe("the persona of a turn that can look but not act", () => {
  // `mcp:read` without `mcp:invoke` is reachable through a custom role: the turn
  // reaches the MCP endpoint and is declared the discovery tools, never the
  // dispatching one. Teaching it `invoke_operation` promises a refusal — and the
  // refusal is the platform's to give, so the persona is silent rather than
  // contradicting itself.
  const DISCOVERY = promptFor(["mcp:read", "chat:write"]);

  it("names no dispatching tool", () => {
    expect(DISCOVERY).not.toContain("invoke_operation");
    expect(DISCOVERY).not.toContain("invoke it");
    expect(DISCOVERY).not.toContain("run_and_wait");
    // Control: the persona that CAN dispatch names it.
    expect(FULL).toContain("invoke_operation");
  });

  it("still teaches discovery and direct file reading", () => {
    expect(DISCOVERY).toContain("search_operations");
    expect(DISCOVERY).toContain("describe_operation");
    expect(DISCOVERY).toContain("you can look things up, you cannot act");
    expect(DISCOVERY).toContain("call `read_file` first");
    expect(DISCOVERY).toContain("Never invent an operationId or argument shape");
    // Control: the discovery tools are named to the full persona too, so their
    // presence here is not an artifact of a branch only this turn renders.
    expect(FULL).toContain("search_operations");
    expect(FULL).toContain("describe_operation");
  });

  it("still carries the permission list, without promising an attempt", () => {
    expect(DISCOVERY).toContain("The context lists the permissions this turn holds");
    expect(DISCOVERY).not.toContain("instead of attempting it");
    expect(FULL).toContain("instead of attempting it");
  });
});
