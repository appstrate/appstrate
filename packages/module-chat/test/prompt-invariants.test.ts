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
import {
  INLINE_MANIFEST_RULE,
  RUN_AND_WAIT_RESUME_INSTRUCTION,
} from "@appstrate/core/run-and-wait-client";
import { callerIdentity } from "./caller-identity.ts";

/** The block's text; the skills it injected are pinned in caller-context.test.ts. */
const contextText = (...args: Parameters<typeof formatCallerContext>) =>
  formatCallerContext(...args).text;

/** The turn's capabilities, from a permission set a role can actually hold. */
function caps(permissions: readonly string[]) {
  return turnCapabilities((permission) => permissions.includes(permission), []);
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
  restricted: false,
  permissions: ["agents:read", "mcp:invoke"],
  skills: DEFAULT_SKILL_SELECTION,
  persists: true,
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

  it("keeps the integrations-over-memory rule for context research, the order being the server's", () => {
    expect(FULL).toContain("use an available integration rather than answering from memory");
    // The preference order (connected, then activated) is the MCP server's instructions'.
    expect(FULL).not.toContain("connected ones first");
  });

  it("keeps the run_and_wait grounding (result is the deliverable)", () => {
    expect(FULL).toContain("run_and_wait");
    expect(FULL).toContain("never fabricate it");
    // Launch-and-wait and fire-and-forget are the server instructions' to teach.
    expect(FULL).not.toContain("fire-and-forget");
  });

  it("shows the task-specific identity in the example, the rule being the tool descriptions'", () => {
    expect(FULL).toContain('"display_name": "Analyse des 3 derniers e-mails"');
    expect(FULL).not.toContain("manifest.display_name");
    expect(FULL).not.toContain(INLINE_MANIFEST_RULE);
  });

  it("keeps the fan-in-by-reference rule (context_files, never a copy)", () => {
    expect(FULL).toContain("context_files");
    expect(FULL).not.toContain("prompt, config?");
    expect(FULL).toContain("Fan in by reference, never by copy");
    expect(FULL).toMatch(/a result retyped into a `prompt` is a result you can get wrong/);
  });

  it("reads file content directly before considering a run", () => {
    expect(FULL).toMatch(/call `read` first/);
    expect(FULL).toMatch(/answer directly from that content/);
    expect(FULL).toMatch(/do NOT launch a run merely to read or analyse it/);
    expect(FULL).toContain("Use files already supplied to your model directly");
    expect(FULL).toContain("metadata or a format the model cannot read");
    expect(FULL).toContain("hand the URI over as `run_and_wait` describes");
  });

  it("keeps the fan-out deliverable contract (file in outputs/ AND a short output)", () => {
    expect(FULL).toContain("outputs/<topic>.md");
    expect(FULL).toMatch(/short summary naming that file/);
  });

  it("asks for a standalone, descriptive filename, the context-free names being the tool descriptions'", () => {
    expect(FULL).toContain("analyse-concurrents-restaurants-lyon.md");
    expect(FULL).toContain("enough subject or scope to stand alone");
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

  // The rules a launch refusal or warning follows are the server instructions' (one copy): the
  // chat layer holds none of them, whatever the capability mix (see the invariant test below).
  it("keeps the canonical example's integration required: its task means nothing without Gmail", () => {
    expect(FULL).toContain('"@appstrate/gmail": { "tools": ["api_call"], "required": true }');
  });

  it("teaches loading a skill through `read_resource` on its URI, one at a time, before acting", () => {
    expect(FULL).toContain("guides for YOU");
    expect(FULL).toContain("LOAD IT BEFORE acting: call `read_resource` with that URI verbatim");
    expect(FULL).toContain("Load ONE at a time");
    expect(FULL).toContain("Never load a skill whose content already appears");
    expect(FULL).toContain(
      "call `read_resource` with the skill's URI, replacing `SKILL.md` with the file's path",
    );
    // The injected ones are already loaded; `read_resource` is for a skill listed by its URI.
    expect(FULL).toContain("One shown in full, inside a `<skill>` tag, is already loaded");
    expect(FULL).not.toContain("getSkill");
  });

  it("names the same heading the context block renders", () => {
    const block = contextText(callerIdentity({ user: { name: "Ada" } }), {
      ...CONTEXT_OPTS,
      skillCatalogue: [
        {
          packageId: "@acme/mine",
          description: "Mine",
          version: null,
          uri: "skill://spc_1/acme/mine/mine/SKILL.md",
        },
      ],
    });
    expect(block).toContain("## Skills");
    expect(FULL).toContain("`## Skills`");
  });

  it("teaches the loading rules whatever the turn may author", () => {
    const readerOnly = promptFor([...MCP, "skills:read"]);
    expect(readerOnly).toContain("call `read_resource` with that URI verbatim");
    expect(readerOnly).toContain("guides for YOU");
  });

  it("teaches `read_resource` without dispatch", () => {
    // `read_resource` is registered on every platform MCP connection.
    const noDispatch = promptFor(["mcp:read", "skills:read"]);
    expect(noDispatch).toContain("call `read_resource` with that URI verbatim");
    expect(noDispatch).toContain("the skills available");
  });

  it("names no skills listing tool in the persona: the catalogue rides the turn's context", () => {
    // Live operation names that answer without the `skill://` URI `read_resource` takes.
    for (const listing of ["listSkills", "listServedSkills"]) {
      expect(FULL).not.toContain(listing);
    }
  });

  it("teaches nothing about skills to a turn without `skills:read`", () => {
    const noSkills = promptFor(BUILDER.filter((permission) => permission !== "skills:read"));
    for (const skillRule of [
      "read_resource",
      "## Skills",
      "Skills are not run on their own",
      "declare it under `dependencies.skills`",
      "the skills available",
      "in `dependencies.skills`",
    ]) {
      expect(FULL).toContain(skillRule);
      expect(noSkills).not.toContain(skillRule);
    }
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
  const identity = callerIdentity({ user: { name: "Ada" }, org: { role: "member" } });

  it("renders the forwarded locale in the reply-language line", () => {
    const out = contextText(identity, { ...CONTEXT_OPTS, locale: "en-US" });
    expect(out).toContain("Reply in the user's language (en)");
  });

  it("defaults the reply language to fr without a locale", () => {
    expect(contextText(identity, CONTEXT_OPTS)).toContain("Reply in the user's language (fr)");
  });

  it("keeps the block free of standing instructions — they belong to the system prompt", () => {
    // Everything the model must DO with the context lives in the persona
    // (`buildSystemPrompt`). The block renders data only; the sole exceptions are the
    // reply-language line, parameterised by the `X-Chat-Locale` header, and the rule on
    // the spaces it lists.
    const out = contextText(identity, {
      ...CONTEXT_OPTS,
      skillCatalogue: [
        {
          packageId: "@appstrate/web-research",
          description: "Research the web",
          version: "1.2.0",
          uri: "skill://spc_1/appstrate/web-research/web-research/SKILL.md",
        },
      ],
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
      "declare it under `dependencies.skills`",
      "call `listRuns` (newest first)",
    ]) {
      expect(FULL).toContain(imperative);
    }
  });

  it("renders neither integrations nor agents: they differ per space and are looked up with the tools", () => {
    const out = contextText(identity, CONTEXT_OPTS);
    expect(out).not.toContain("Integrations the user has connected");
    expect(out).not.toContain("## Existing agents you can run");
    expect(out).not.toContain("The user has no connected integrations yet");
  });
});

describe("the persona without inline composition", () => {
  // What a turn without `agents:write` ∧ `agents:run` is told. The platform
  // refuses the launch either way; this block is about not teaching it.

  it("teaches no way to compose one", () => {
    expect(REDUCED).not.toContain('kind:"inline"');
    expect(REDUCED).not.toContain(INLINE_MANIFEST_RULE);
    expect(REDUCED).not.toContain("Give EVERY inline run a task-specific identity");
    expect(REDUCED).not.toContain("runInline");
  });

  it("keeps every rule that is not about composing one", () => {
    expect(REDUCED).toContain("You are Appstrate's assistant");
    expect(REDUCED).toContain("Never quote run metrics");
    expect(REDUCED).toContain("use an available integration rather than answering from memory");
    expect(REDUCED).toContain("call `read` first");
    expect(REDUCED).toContain('`kind:"agent"`');
    expect(REDUCED).toContain("The context lists the permissions this turn holds");
  });

  it("states the published-agent and `output` contracts once, in both personas", () => {
    for (const shared of [
      "Content returned only through the `output` tool is plain data for YOU",
      "render as downloadable chips in this chat",
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
    expect(FULL).toContain("offer to compose an inline run instead");
    expect(REDUCED).not.toContain("offer to compose an inline run instead");
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

describe("the integration tools", () => {
  const PROXY = [...BUILDER, "credential-proxy:call-own"];
  const space = (permissions: string[], credentialProxyOpen: boolean) => ({
    permissions,
    credentialProxyOpen,
  });
  const withTools = buildSystemPrompt(
    turnCapabilities((p) => PROXY.includes(p), [space(PROXY, true)]),
  );

  it("explains temporary file reads and requires a reproducible source to retain an exact revision", () => {
    expect(withTools).toContain("read_as_file: true");
    expect(withTools).toContain("same strong ETag using If-Match");
    expect(withTools).toContain("ask before saving another version");
    expect(withTools).toContain("Use a run for Office formats");
    expect(FULL).not.toContain("read_as_file: true");
  });

  it("are offered only where a turn space holds `mcp:invoke` and a proxy grant and leaves the proxy open", () => {
    const offered = (turn: string[], spaces: ReturnType<typeof space>[]) =>
      turnCapabilities((p) => turn.includes(p), spaces).callsIntegrationTools;
    expect(offered(PROXY, [space(PROXY, true)])).toBe(true);
    expect(offered(PROXY, [space(PROXY, false)])).toBe(false);
    expect(offered(PROXY, [space(BUILDER, true)])).toBe(false);
    // The turn's set is a ceiling over each space's.
    expect(offered(BUILDER, [space(PROXY, true)])).toBe(false);
    expect(offered(PROXY, [space(BUILDER, true), space(PROXY, true)])).toBe(true);
    expect(offered(PROXY, [])).toBe(false);
  });

  it("are preferred over a run when offered, the inline guidance kept for a run", () => {
    expect(withTools).toContain("found with `search` and called with `call_integration_tool`");
    expect(withTools).toContain("its `integration_tool` kind");
    expect(withTools).toContain("call it with `call_integration_tool`, and answer from its result");
    expect(withTools).toContain("Run an agent instead when the task needs a runtime");
    expect(withTools).not.toContain("MUST be carried out by running an agent");
    expect(withTools).not.toContain("use any integration or MCP directly");
    expect(withTools).toContain('kind:"inline"');
  });

  it("are absent when not offered, the run rule unchanged", () => {
    expect(FULL).not.toContain("integration_tool");
    expect(FULL).not.toContain("call_integration_tool");
    expect(FULL).toContain("MUST be carried out by running an agent");
    expect(FULL).toContain(
      "- If the request needs an integration, an MCP, or any external action, run an agent:",
    );
    expect(FULL).toContain('kind:"inline"');
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
    expect(NO_RUNS).toContain("call `read` first");
    expect(NO_RUNS).toContain("The context lists the permissions this turn holds");
  });

  it("keeps skill authoring, which needs no run", () => {
    expect(NO_RUNS_AUTHOR).toContain("Skills are not run on their own");
    expect(NO_RUNS_AUTHOR).toContain("in `dependencies.integrations` and in `dependencies.skills`");
    expect(NO_RUNS).not.toContain("Skills are not run on their own");
    // The skills list is whole and the agents list is not rendered: no truncated-list bullet.
    expect(NO_RUNS).not.toContain("(list truncated)");
    expect(NO_RUNS_AUTHOR).not.toContain("(list truncated)");
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
    expect(RUNNER.length - NO_RUNS.length).toBeGreaterThan(3_000);
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
    expect(DISCOVERY).toContain("You can look things up, you cannot act");
    expect(DISCOVERY).toContain("call `read` first");
    // The tools' own names and the operation lookup are the server instructions'.
    expect(FULL).not.toContain("You can look things up, you cannot act");
  });

  it("still carries the permission list, without promising an attempt", () => {
    expect(DISCOVERY).toContain("The context lists the permissions this turn holds");
    expect(DISCOVERY).not.toContain("instead of attempting it");
    expect(FULL).toContain("instead of attempting it");
  });
});

describe("the persona and package authoring", () => {
  const CREATES = "To create a package — an agent, a skill or an integration";
  const FORBIDS = "Do not create, import or modify any package";

  it("teaches creating every package type on a write on any one of them", () => {
    for (const write of ["agents:write", "skills:write", "integrations:write"]) {
      const prompt = promptFor([...MCP, write]);
      expect(prompt).toContain(CREATES);
      expect(prompt).toContain("`import_package_file`");
      expect(prompt).not.toContain(FORBIDS);
    }
  });

  it("forbids it when the turn holds no package write — the switch off", () => {
    const prompt = promptFor([...MCP, "agents:run", "runs:read", "skills:read"]);
    expect(prompt).toContain(FORBIDS);
    expect(prompt).not.toContain(CREATES);
  });

  it("says nothing of it to a turn that cannot dispatch", () => {
    const prompt = promptFor(["mcp:read", "agents:write"]);
    expect(prompt).not.toContain(CREATES);
    expect(prompt).not.toContain(FORBIDS);
  });
});

describe("the context block and the spaces: facts, never a rule", () => {
  const ada = callerIdentity({ user: { name: "Ada" } });

  it("words the permissions as the union, each call decided where it is named", () => {
    const out = contextText(ada, CONTEXT_OPTS);
    expect(out).toContain(
      "Permissions this turn (the union over the spaces you can act in; each call is decided in the space it names, by your role there): agents:read, mcp:invoke",
    );
  });

  it("marks the permissions of a role preview, and names an empty set", () => {
    const out = contextText(ada, { ...CONTEXT_OPTS, rolePreview: true, permissions: [] });
    expect(out).toContain(
      "Permissions this turn (role preview active) (the union over the spaces you can act in; each call is decided in the space it names, by your role there): none",
    );
  });

  it("names the space the conversation was opened in, and nothing else about spaces", () => {
    const out = contextText(ada, { ...CONTEXT_OPTS, origin: { id: "spc_b", name: "Beta" } });
    expect(out).toContain("This conversation was opened in Beta (`spc_b`).");
    expect(out).not.toContain("space_id");
    expect(out).not.toContain("limited");
  });

  it("says nothing of a space when the conversation has none", () => {
    const out = contextText(ada, CONTEXT_OPTS);
    expect(out).not.toContain("This conversation was opened in");
    expect(out).not.toContain("space_id");
    expect(out).not.toContain("personal space");
    expect(out).not.toContain("default space");
    expect(out).not.toContain("Ask the user which space");
  });

  it("names the one space a limited conversation acts in, and that the user lifts the limit", () => {
    const out = contextText(ada, {
      ...CONTEXT_OPTS,
      origin: { id: "spc_b", name: "Beta" },
      restricted: true,
    });
    expect(out).toContain(
      "This conversation was opened in Beta (`spc_b`) and is limited to it: no other space can be reached.",
    );
    expect(out).toContain("The user lifts the limit in the composer");
    expect(out).not.toContain("spc_a");
    expect(out).not.toContain("pass `");
  });
});

describe("the persona and the caller context", () => {
  /** The sentence that sends the model to `get_me`, or undefined when there is none. */
  const getMeSentence = (prompt: string) =>
    prompt
      .split("\n")
      .find((line) => line.startsWith("Your context block below is DATA"))
      ?.match(/For any other space[^.]*\./)?.[0];
  const LEAD =
    "For any other space, or once a connection or an activation changed one during the turn, `get_me` returns";
  const PER_SPACE = "for the space it names.";

  it("sends the model to get_me for a space the context does not detail, for both when the turn reads both", () => {
    expect(getMeSentence(promptFor([...BUILDER, "integrations:read"]))).toBe(
      `${LEAD} the integrations they have connected (\`connections\`) and the agents they can run (\`agents\`) ${PER_SPACE}`,
    );
  });

  it("names in the get_me sentence only what the turn's grants make it return", () => {
    // `GET /api/me/context` lists connections under `integrations:read` and agents under `agents:run`.
    expect(getMeSentence(FULL)).toBe(`${LEAD} the agents they can run (\`agents\`) ${PER_SPACE}`);
    expect(getMeSentence(promptFor([...MCP, "integrations:read"]))).toBe(
      `${LEAD} the integrations they have connected (\`connections\`) ${PER_SPACE}`,
    );
    // `get_me` exists only over the transport; without it the sentence names no tool.
    expect(getMeSentence(promptFor(["integrations:read"]))).toBeUndefined();
  });

  it("finds runnable agents in the context first, then with get_me for another space", () => {
    expect(FULL).toContain(
      "are the agents the user can run in the spaces it covers, each with the spaces it is active in, whether it is a draft only and whether it takes input; for a space it does not cover, `get_me` with that `space_id` lists them, each with `published`, `home_writable` and `takes_input`",
    );
    expect(FULL).toContain("`published: false` and `home_writable: false`");
    // Truncation is the get_me description's: `search` finds the rest.
    expect(FULL).not.toContain("agents_truncated");
  });
});

describe("the chat layer holds no common-layer rule", () => {
  // Each rule below is written once, in the server instructions or a tool description. The chat
  // layer supplies facts and chat-specific guidance only: a second copy drifts (#2343).
  const COMMON_FRAGMENTS = [
    INLINE_MANIFEST_RULE,
    RUN_AND_WAIT_RESUME_INSTRUCTION,
    "personal_space_takes_no",
    "active_in_spaces",
    "granted_in",
    "connected ones first",
    "override_outranked",
    "must_choose_connection",
    "required_integration_unbound",
    "integration_not_active",
    "offerPackageToOrg",
    "activatePackage",
    "agent_not_active_in_space",
    "inline_run_not_allowed_in_space",
    "connection_overrides",
    "your personal space",
    "personal space",
    "default space",
    "names no space",
    "never switch",
    "validateInlineRun",
    "agents_truncated",
    "one-shot",
    "context-free names",
    "fire-and-forget",
    "Never invent an operationId",
    "Never activate a package",
    'version:"draft"',
    "draft_not_writable",
    "no_published_version",
  ];
  const MIXES: Record<string, readonly string[]> = {
    builder: BUILDER,
    "builder with integrations": [...BUILDER, "integrations:read"],
    "builder with proxy": [...BUILDER, "integrations:read", "credential-proxy:call-own"],
    reduced: BUILDER.filter((permission) => permission !== "agents:write"),
    "no runs, author": [...MCP, "agents:write", "skills:read"],
    "no runs": MCP,
    discovery: ["mcp:read", "chat:write"],
  };
  const withProxy = (permissions: readonly string[]) =>
    buildSystemPrompt(
      turnCapabilities(
        (permission) => permissions.includes(permission),
        [{ permissions: [...permissions], credentialProxyOpen: true }],
      ),
    );

  for (const [mix, permissions] of Object.entries(MIXES)) {
    it(`states none of them: ${mix}`, () => {
      const persona = withProxy(permissions);
      const block = contextText(
        callerIdentity({ user: { name: "Ada" }, org: { role: "member" } }),
        {
          ...CONTEXT_OPTS,
          capabilities: caps(permissions),
          origin: { id: "spc_b", name: "Beta" },
          restricted: true,
        },
      );
      for (const fragment of COMMON_FRAGMENTS) {
        expect(persona).not.toContain(fragment);
        expect(block).not.toContain(fragment);
      }
    });
  }
});
