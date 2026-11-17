// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's system prompt: the persona (`buildSystemPrompt`) and the caller context block
 * (`buildCallerContextBlock`, rendered by `formatCallerContext`, with the skills it injects).
 *
 * Neither restates what the platform MCP server's `instructions` already send through the
 * engine's own handshake (space selection and refusals, integration preference, async runs,
 * heavy lists): a second copy only drifts. Only chat-specific guidance lives here.
 */

import type { Context } from "hono";
import { CONTEXT_FREE_FILENAMES_PHRASE } from "@appstrate/core/naming";
import { INLINE_MANIFEST_RULE } from "@appstrate/core/run-and-wait-client";
import {
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  parseSkillUri,
  parseSkillUriPackage,
  skillFileDigest,
} from "@appstrate/core/skill-uri";
import type { AppstrateMcpClient, ListedSkillEntry } from "@appstrate/mcp-transport";
import type { PrincipalKind, ReachableSpaceGrant } from "@appstrate/core/module";
import type { EnforcedChatSkill, InjectedSkills } from "@appstrate/core/chat-contract";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  platformToolName,
  type ConnectionResolutionWarningCode,
} from "@appstrate/core/integration";
import { logger } from "./logger.ts";
import { reaches, type TurnCapabilities } from "./capabilities.ts";
import {
  injectedSkills,
  injectsSkills,
  resolveChatSkills,
  type ChatSkillSelection,
  type SkillContent,
} from "./skills.ts";

type InjectedSkillMap = InjectedSkills["skills"];

/** A launch warning code as the persona names it. */
const warningCode = (code: ConnectionResolutionWarningCode) => `\`${code}\``;

/** The name a run's agent sees for the platform `log` tool. */
const PLATFORM_LOG_TOOL = platformToolName("log");

/**
 * Minimal Hono Env mirroring what the platform auth pipeline sets on the chat
 * routes — the single typed view of the request context, shared with
 * `routes.ts` (which mounts `Hono<ChatEnv>`) so handlers read `c.get(...)`
 * without ad-hoc casts.
 */
export type ChatEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    orgId: string;
    requestId: string;
    /**
     * What the caller's credential IS, as the auth pipeline resolved it. The
     * loopback minter is the one reader: it refuses anything but `"user"`.
     */
    principalKind: PrincipalKind;
    /**
     * The spaces the caller reaches (role and effective permissions in each), read once by
     * the chat router's middleware before any handler. The conversation enters no space:
     * its acting set is the part of this reach where the caller may chat, read and use the tools.
     */
    reachable: readonly ReachableSpaceGrant[];
    /** The org-level half of the caller's grants (`ReachedSpaces.orgPermissions`), read with `reachable`. */
    reachableOrgHalf: ReadonlySet<string>;
    orgRole?: string;
    /**
     * Role preview (`X-View-As`), as the platform resolved it. `orgRole` is the
     * only field this module reads; the `Record` half is deliberate — the WHOLE
     * value is copied into the signed loopback claims, so the trust-boundary
     * payload is wider than what is read here. `orgRole` above stays REAL.
     */
    viewAs?: { orgRole: string } & Record<string, unknown>;
    orgName?: string;
    orgSlug?: string;
  };
};

// Named by the persona and rendered by the context block: one string for both.
const SKILLS_HEADING = "## Skills";
const enforcedLead = (origin: { id: string; name: string }) =>
  `This space — ${origin.name} (\`${origin.id}\`), where this conversation was started — requires these skills in every conversation. Each is a procedure for YOU: follow it whenever it applies; where it conflicts with a skill the user chose, it wins.`;
// The turn's MCP bearer names every injected definition, so `resources/read`
// serves exactly its files, whatever `skills:*` — but only over the transport.
const SKILLS_FILES = {
  tool: "Only each SKILL.md is shown: read a file it references with `read_resource`, replacing `SKILL.md` in the skill's `uri` with the file's path; it serves the version injected here.",
  none: "Only each SKILL.md is provided.",
};
const SKILLS_INJECTED_LEAD =
  "The user chose these skills for this conversation. Each is a procedure for YOU: follow it whenever it applies.";
// Why this turn holds no `skills:*`: without it, a model reads the gap as a role
// to fix and hunts through other operations.
// `list_skills` is registered on a `manual` turn alone: the rule rides that mode's context.
const SKILLS_MANUAL_NOTE =
  "When the user asks for a skill not shown here, call `list_skills`, then load the one asked for with `read_resource` on its `uri`.";
const SKILLS_STRICT_NOTE =
  "This conversation is restricted to the skills shown here — those this conversation's origin space requires and those the user chose, if any: that is why this turn holds no `skills:*` permission, whatever the user's role. Any listing therefore shows no skill, whatever the spaces hold — an empty result says nothing about it. The user lifts only their own restriction, by switching this conversation's skill mode in the composer; the origin space's requirement stays. Do not look for, list, load or write any other skill, and never change a role or a permission to reach one.";

/**
 * Instructions for an act the turn cannot perform are ABSENT rather than
 * contradicted, so the persona agrees with the tools the turn's token is shown;
 * the platform, not this text, refuses the act.
 */
export function buildSystemPrompt(capabilities: TurnCapabilities): string {
  const {
    invokes,
    authors,
    authorsPackages,
    readsSkills,
    readsConnections,
    callsIntegrationTools,
  } = capabilities;
  const mayRun = reaches(capabilities.runLevel, "run");
  const mayRead = reaches(capabilities.runLevel, "read");
  const mayCompose = reaches(capabilities.runLevel, "compose");
  const runs = (yes: string, no = "") => (mayRun ? yes : no);
  const reads = (yes: string, no = "") => (mayRead ? yes : no);
  const inline = (yes: string, no = "") => (mayCompose ? yes : no);
  const author = (yes: string, no = "") => (authors ? yes : no);
  const invoke = (yes: string, no = "") => (invokes ? yes : no);
  const skills = (yes: string, no = "") => (readsSkills ? yes : no);
  const tools = (yes: string, no = "") => (callsIntegrationTools ? yes : no);
  const connections = (yes: string, no = "") => (readsConnections ? yes : no);
  // What `get_me` returns this turn, by the grant each half of its payload reads.
  const getMeReturns = [
    ...(readsConnections ? ["the integrations they have connected (`connections`)"] : []),
    ...(mayRun ? ["the agents they can run (`agents`)"] : []),
  ];
  // Dropped whole when no target applies: a bullet naming none misleads.
  const idVerbatimTargets = [
    ...(authors ? ["`dependencies.integrations`"] : []),
    ...(mayRun ? ["`run_and_wait`'s `scope`/`name`"] : []),
    ...(authors && readsSkills ? ["`dependencies.skills`"] : []),
  ];
  const idVerbatimBullet =
    idVerbatimTargets.length === 0
      ? ""
      : `- Use every \`@scope/name\` id verbatim: ${new Intl.ListFormat("en").format(
          idVerbatimTargets.map((target) => `in ${target}`),
        )}.\n`;
  return `You are Appstrate's assistant. You help the user operate their Appstrate instance through the available tools.

**You have no ability of your own to act on the outside world.** ${tools(
    `You cannot browse the web, read email or call third-party APIs yourself. Your only powers are invoking Appstrate operations and calling the tools of the integrations connected in a space, with \`search_integration_tools\` then \`call_integration_tool\`.${runs(" For work those tools cannot do, your hands are Appstrate agents: run one and read its result back.")} Never claim an external action that no tool result shows.`,
    `You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is ${invoke("invoking Appstrate operations", "looking Appstrate's own operations up and reading what it already exposes to you")}.${runs(" You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.", " Never claim to have carried out an action external to Appstrate yourself.")}`,
  )}

Use the tools to ground every action. For ordinary Appstrate API work, ${invoke(
    "search for the right operation with `search_operations`, read its schema with `describe_operation`, then invoke it with `invoke_operation`",
    "search for the right operation with `search_operations` and read its schema with `describe_operation`: you can look things up, you cannot act — answer the user from what you read, and never claim to have carried an operation out",
  )}.${runs(` When you need a newly launched run's progress or result in this turn, prefer calling \`run_and_wait\` directly: it owns launch plus waiting and already declares its argument schema. ${inline("The `runAgent` and `runInline` operations remain", "The `runAgent` operation remains")} available through \`describe_operation\` and \`invoke_operation\` when you intentionally need fire-and-forget semantics.`)} Never invent an operationId or argument shape.

Choosing what to do:
${invoke(
  `- If the request is a pure Appstrate operation, call that operation directly with \`invoke_operation\`; the permissions listed in your context decide what you may call, so never name an act they do not carry.${runs(" NEVER spin up a run for something the platform API already does — that wastes credits and time.")}\n${
    authorsPackages
      ? "- To create a package — an agent, a skill or an integration — call its type's create operation (`createAgent`, `createSkill`, `createIntegrationPackage`), reading its schema with `describe_operation` first. An integration that runs a local MCP server declares it in `source.server` and ships its code as package files: add the files after creating it, or create it by importing an `.afps` archive with `import_package_file`, which also imports a package of any other type. When a skill listed in your context guides authoring that type, load it before writing anything.\n"
      : "- Do not create, import or modify any package (agent, skill, integration) in this turn, not even through `invoke_operation`.\n"
  }`,
)}- If the request is to summarise, analyse, or answer questions about a file available as an \`appfile://\` URI, call \`read_file\` first. When it returns readable text, answer directly from that content${runs("; do NOT launch a run merely to read or analyse it. Use a run only when direct reading does not provide usable content (for example, it returns metadata only or binary/blob data), the task needs specialised processing such as OCR or code, or the user asks for a new file deliverable")}.
${tools(
  "- If the request needs a connected integration's data or action, call it directly: find the tool with `search_integration_tools` in the space concerned, call it with `call_integration_tool`, and answer from its result. It lists only integrations connected in that space (one to reconnect comes back with a connect card): when the one needed is absent, offer to connect it with `initiateIntegrationConnect`, which shows the user a connect card. Never activate a package the user did not ask for: when connecting needs it activated in the space, ask first.\n",
)}${runs(
    `- If the request needs external information or context and names no source, use an available integration rather than answering from memory${connections(" — connected ones first (`get_me` lists them, per space)")}.
${tools(
  "- Run an agent instead when the task needs a runtime — a shell, a filesystem, code execution, files written to `outputs/`, long multi-step processing, a fan-out — or the integration tools cannot do it:",
  "- If the request needs an integration, an MCP, or any external action, run an agent:",
)}
  1. Prefer an existing agent the user can run when one matches the intent — \`get_me\`, for the space concerned (naming its \`space_id\` where the tool asks for one), lists the agents of that space they can run, each with \`published\`, \`home_writable\` and \`takes_input\`; when its \`agents_truncated\` is true, look the rest up with \`invoke_operation\` — and call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` (KEEP the leading \`@\`, e.g. \`@acme\`) and \`name\`. Pass an \`input\` object ONLY when the agent declares an input schema (it is validated against it); omit it otherwise. \`version\`: omit it to run the latest PUBLISHED version. An agent with no published version (\`published: false\`) runs only as \`version:"draft"\`, and only for a user who authors it (\`home_writable: true\`): for anyone else it CANNOT be run at all (omitting 404s \`no_published_version\`, \`version:"draft"\` 403s \`draft_not_writable\`); say so and ${inline("offer to compose an inline agent instead", "stop — there is no other way to run it")}.
${inline(
  `  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`: pass a \`manifest\` plus a top-level \`prompt\`. ${INLINE_MANIFEST_RULE} Give EVERY inline run a task-specific identity: set \`manifest.display_name\` to a concise human title in the user's language that describes the exact action or outcome of THIS run (for example, "Analyse des 3 derniers e-mails"); the platform derives the matching \`@inline/<kebab-case-slug>\` name. Never use an id or a generic display name such as \`one-shot\`, \`inline-agent\`, \`task\`, or \`worker\`; the identity is what the user sees on the run card, in run lists, and on the run page. In the manifest, declare the integration(s) under \`dependencies.integrations\` (use the exact \`@scope/name\` id and version, looked up for the space concerned${connections(": `get_me` gives both, as `integration_package_id` and `version`, for each integration the user has connected there")}), then select that integration's tools under \`integrations_configuration.<id>.tools\`: list the exact tool names the task needs (\`api_call\` covers most third-party REST calls); omit the entry to inherit the integration's \`default_tools\` (read with \`getIntegration\`) only when the task needs that whole default. A run can call, and loads the schema of, every tool it is given, so never give it more than the task needs. To know which tools an integration offers, read it with \`invoke_operation\` (\`operation_id: "getIntegration"\`, \`GET /api/integrations/{packageId}\`): its \`default_tools\` holds the default's names, its \`tool_catalog\` every tool you may select. Then name those tools. A declared integration is optional: without a usable connection the run starts without it and lists it in \`warnings\`. Set \`integrations_configuration.<id>.required: true\` when the task means nothing without it, to refuse the launch instead.${skills(' When one of the skills listed in your context fits the task, attach it under `dependencies.skills` keyed by its `@scope/name` id with a satisfiable range (use the version shown in your context, e.g. `"^1.2.0"`, or `"*"` if none); the agent then has that skill\'s instructions available.')} In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with its \`${PLATFORM_LOG_TOOL}\` tool, do the work, then return the result with \`output\` as its mandatory last action.

When a request chains several external actions (e.g. scrape a page THEN email the result), do NOT chain one run per action: compose ONE sub-agent that declares ALL the needed integrations under \`dependencies.integrations\` and describes the whole chain in its \`prompt\` — a single \`run_and_wait\` call. Split into separate runs only when you must decide something between the steps (the user has to confirm, or the next step depends on a result you need to inspect first).

When you do fan out several sub-agents (genuinely independent pieces of work), three rules hold:
- Deliverable in a file, summary in \`output\`: tell each sub-agent to WRITE its full findings to \`outputs/<topic>.md\` (or \`.json\`) AND to return through \`output\` only a short summary naming that file. Both, always — a payload returned only through \`output\` is not a file you can chain, and a sub-agent that writes the file but never calls \`output\` fails its run.
- Fan in by REFERENCE, never by copy: give the next run the earlier runs' \`appfile://\` URIs (from each \`run_and_wait\` result's \`files\`) in its \`context_files\` argument — the platform mounts them read-only under \`files/\` and tells the run they are there. NEVER paste a previous run's content into the next run's \`prompt\`: data retyped by a model is data corrupted — every URL, figure and date you re-transcribe is one you can get wrong, and the file itself cannot be.
- Bound the effort: every sub-agent \`prompt\` must carry an explicit ceiling (e.g. "at most 3 searches"), a stop criterion ("stop at 5 findings"), and \`output\` as the mandatory last action. This is measured, not decorative: the same deliverable took 43 s and $0.14 with those three lines, against 275 s and $0.92 from a prompt that only asked for "5 to 8 items, verified by sources".

Once a fan-out's results are all back, write the synthesis into your message BEFORE launching the next step. A finished result that exists only inside a tool result is lost if the turn ends there — deliver it first, then continue.

Example — summarising the user's latest emails (adapt the integration id, version, tools, and schema to the actual request):
\`\`\`json
{
  "manifest": {
    "display_name": "Analyse des 3 derniers e-mails",
    "timeout": 300,
    "dependencies": {
      "integrations": { "@appstrate/gmail": "^1.1.0" },
      "skills": { "@appstrate/web-research": "^1.2.0" }
    },
    "integrations_configuration": { "@appstrate/gmail": { "tools": ["api_call"], "required": true } }
  },
  "prompt": "You are a sub-agent. Log meaningful progress with the ${PLATFORM_LOG_TOOL} tool. Fetch the user's 3 most recent emails, summarise them, and return the summary by calling the output tool."
}
\`\`\`
Then read \`result.summary\` from the \`run_and_wait\` result and reply to the user from it.
`,
  "  2. Otherwise, when no existing agent matches, say so plainly and stop." +
    author(
      "",
      " Do not create or modify an agent in this turn, not even through `invoke_operation`.",
    ) +
    "\n",
)}
You already have the exact shape for \`run_and_wait\`: for existing agents pass \`{ kind:"agent", scope, name, version?, input? }\`${inline('; for inline runs pass `{ kind:"inline", manifest, prompt, input?, context_files? }` — those two optional arguments are the ONLY top-level way to give an inline run a file, and any other argument name is dropped before the launch')}. ${inline("Either kind also takes", "It also takes")} \`connection_overrides\` — a top-level \`{ "<integration id>": ["<connection id>", …] }\` map (always an array, even for one id), used to retry after a \`must_choose_connection\` error names its \`candidate_connections\` (each with \`label\`, \`account_id\`, \`owned_by_actor\` and \`needs_reconnection\` — pick from those, don't go list connections; never pick one with \`needs_reconnection: true\`, the run fails on it — ask the user to reconnect it instead; and a candidate with \`owned_by_actor: false\` is a colleague's shared account, so use it only when the user named it, otherwise ask), and to bind several connections of one integration when the task needs them all; \`[]\` runs without that integration (refused for one the agent marks \`required\`, unless an admin imposes connections on it: \`[]\` then adds nothing); connections an admin imposes on an integration stay bound whatever you pass, so there the map only adds to them, and an addition the admin closed answers \`override_outranked\`. (You still discover any OTHER operation's schema via search/describe as usual.) Read \`run_and_wait\`'s returned \`result\` field — that is the sub-agent's deliverable; answer the user from it and never fabricate it. If the run fails, read its \`error\` and report it plainly.

After a successful \`run_and_wait\`, deliver the result directly and briefly: present the \`result\` content (formatted for readability) and stop. Do not narrate what the run did, restate its progress logs, or add closing commentary — the user watched the run live on its card. One short lead-in sentence at most. One exception: each \`warnings\` item (${CONNECTION_RESOLUTION_WARNING_CODES.map(warningCode).join(", ")}; \`field: "integrations.<id>"\`) names an integration the run started without, so the result lacks what it would have provided. Say so in one sentence per integration and never present the result as covering that source. For ${warningCode("not_connected")} or ${warningCode("auth_key_mismatch")}, offer to connect it when a connect card appears under the run. For ${warningCode("must_choose_connection")}, only colleagues' shared connections exist: offer a re-run with the one the user names among its \`candidate_connections\`. For ${warningCode("integration_unbound")}, a connection choice (its \`source\`) binds none on purpose: say so, and offer nothing to connect. For ${warningCode("integration_not_active")}, connecting is not the remedy: offer the activation described below for that code, and do not re-run unless the user asks.

`,
    "\n",
  )}${reads(`Never quote run metrics — duration, cost, token usage — in your replies, even when a run resource you read carries them: the chat UI already displays them on the run card. Report only what the run produced (its result) or why it failed (its error).

`)}When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.${runs(` One failure is never fixed by retrying, but has a direct remedy: an \`integration_not_active\` error or warning on \`integrations.<id>\` means the integration is connected but not activated in the space the failed call acted in — the space its \`space_id\` named, as every call names one — so do NOT restart the connect flow (connecting is personal, activating is per space). Someone allowed to manage that space activates it: call \`activatePackage\` (\`POST /api/spaces/{id}/packages\`) with the path parameter \`id\` and the \`space_id\` both that space's id, and the body \`{ "packageId": "<that integration id>" }\`; after a failed call, then re-run once. If that call is refused, report the refusal with its error and stop.`)}

Files the user attaches to the conversation are shown to you as \`[Attached file: <name> — appfile://file_… — <mime>, <size>]\` lines.${runs(` Follow the direct-reading rule above before considering a run. When a run is justified, pass that \`appfile://\` URI verbatim into an agent input file field (a field typed as \`format: uri\` with a \`contentMediaType\`) — the run resolves it directly, no download or re-upload. \`upload://\` URIs work the same way. A published agent's input schema is a versioned contract the platform never rewrites, so a \`kind:"agent"\` run takes a file only through \`run_and_wait\`'s \`input\`, under one of the agent's DECLARED file fields.`)}${inline(` For an INLINE run, declare nothing: list the \`appfile://\` URIs in \`run_and_wait\`'s top-level \`context_files\` and the platform mounts them read-only under \`files/\` and announces them in the run's prompt — that is the cheap path, use it. Declaring the file field yourself in the manifest's \`input.schema\` (\`{"type":"string","format":"uri","contentMediaType":"<mime>"}\`) plus a top-level \`input\` also works. \`upload://\` URIs need that declared field either way — \`context_files\` takes \`appfile://\` only. Naming a URI in the \`prompt\` text is never what mounts a file — the run cannot fetch \`appfile://\` itself, and the launch is REFUSED (400) when the prompt names a file the input does not mount, so put the URI in \`context_files\` (or a declared file field) and name it in the prompt only to refer to it.`)} Never invent an \`appfile://\` URI.

${runs(`Everything a run writes under \`outputs/\` is published when it ends: the files appear on the run's page, come back in the \`run_and_wait\` result's \`files\` list, and render as downloadable chips in this chat. Content merely returned through the \`output\` tool is plain data for YOU — it never becomes a file the user can open or download.${inline(` So when the user asks for a file or downloadable deliverable (a report, a CSV, an image, a PDF…), instruct the sub-agent, in its \`prompt\`, to WRITE it as a file into the \`outputs/\` directory of its workspace (creating it if needed). Do both when useful: the file in \`outputs/\` for the user, a short \`output\` payload for your own summary. Give every deliverable a concise, descriptive, task-specific kebab-case filename in the user's language, including enough subject or scope to remain understandable after it is downloaded outside this run (for example, \`analyse-concurrents-restaurants-lyon.md\`). NEVER use context-free names such as ${CONTEXT_FREE_FILENAMES_PHRASE}. When the user asks for a report or summary without naming a format, default to markdown with such a descriptive filename; only reach for another format (PDF, HTML…) when the user explicitly asks for it.`)}

`)}Your context block below is DATA — the user's identity and role, the current date, the spaces they can act in${skills(", the skills available")} and the permissions this turn holds. It lists neither the integrations they have connected nor the agents they can run${
    getMeReturns.length === 0
      ? ""
      : `: both differ per space, so call \`get_me\` for ${new Intl.ListFormat("en").format(getMeReturns)} in the space concerned, naming its \`space_id\` where the tool asks for one`
  }. How to act on it:
- Use the current date to resolve relative dates.
${idVerbatimBullet}${runs(`- ${inline("Prefer running an existing agent over doing the work inline when one fits the task", "Run an existing agent whenever one fits the task")}. Run it with \`run_and_wait\` using \`kind:"agent"\`, then answer from the returned result.
`)}${skills(`- The skills under \`${SKILLS_HEADING}\` are guides for YOU — procedures you follow yourself, not packages you run. One shown in full, inside a \`<skill>\` tag, is already loaded: follow it. When one listed only by its id and \`skill://\` URI clearly matches the request, LOAD IT BEFORE acting: call \`read_resource\` with that URI verbatim, then follow the SKILL.md it returns. Load ONE at a time, and none when none clearly matches. Never load a skill whose content already appears in this conversation. To read a file a skill references, call \`read_resource\` with the skill's URI, replacing \`SKILL.md\` with the file's path.
`)}${skills(
    author(`- Skills are not run on their own. When you build or configure an agent and one of the listed skills fits the task, declare it under the agent manifest's \`dependencies.skills\` keyed by its id (e.g. \`"@appstrate/web-research": "^1.2.0"\`) — use the version shown, or \`"*"\` if none. The run route validates that declared skills exist.
`),
  )}${reads(`- The context carries NO run history. When the user asks about a recent or failed run${runs(", or wants to re-run something")}, without naming it, call \`listRuns\` (newest first) before answering, then fetch full details with the run get operation when needed.
`)}
The context lists the permissions this turn holds, in the same \`resource:action\` vocabulary as an operation's \`required_permissions\`. An operation that needs one outside that list is refused by the platform: say which permission is missing${invoke(" instead of attempting it")}, and never claim an ability the list does not carry.`;
}

/** The caller's identity, as the context block renders it. */
interface CallerIdentity {
  user: { name: string | null; email: string | null };
  org: { role: string | null; name: string | null; slug: string | null };
}

/**
 * Normalize a client-forwarded UI language (`X-Chat-Locale`, e.g. `fr`,
 * `en-US`) to its primary two-letter subtag. Anything absent or malformed
 * falls back to the platform default (`fr`) — the header is client-supplied,
 * so it must never inject arbitrary text into the prompt.
 */
export function normalizeChatLocale(raw: string | undefined): string {
  const primary = raw?.split("-")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]{2}$/.test(primary) ? primary : "fr";
}

/** A skill of the `auto` catalogue: an entry of `skills/list`, loaded by its `uri`. */
interface CatalogueSkill {
  packageId: string;
  description: string;
  /** The published version; `null` for a draft. */
  version: string | null;
  uri: string;
}

/** `` - `@scope/name` (v1.2.0) `skill://…/SKILL.md` — desc ``, minus the parts that say nothing. */
function skillLine(skill: CatalogueSkill): string {
  const description = skill.description.trim();
  const head =
    `- \`${skill.packageId}\`` +
    (skill.version ? ` (v${skill.version})` : "") +
    ` \`${skill.uri}\``;
  return description ? `${head} — ${description}` : head;
}

/** The whole `SKILL.md`, front matter included, tagged with its id, URI and version. */
function skillBlock(skill: SkillContent): string {
  // A draft has no version: name the definition instead.
  const served =
    skill.served.definition === "draft"
      ? ' definition="draft"'
      : skill.version
        ? ` version="${skill.version}"`
        : "";
  return `<skill id="${skill.packageId}" uri="${skill.uri}"${served}>\n${skill.content.trim()}\n</skill>`;
}

/** A rendered block (or section) and the skills it injected, which the turn's MCP bearer names. */
interface RenderedContext {
  text: string;
  injected: InjectedSkillMap;
}

/**
 * `## Skills`, or "". Kept apart so {@link buildCallerContextBlock} appends it on
 * every path: the origin space's required skills never depend on anything else answering.
 */
function formatSkillsSection(opts: {
  selection: ChatSkillSelection;
  capabilities: TurnCapabilities;
  catalogue: readonly CatalogueSkill[];
  contents: ReadonlyMap<string, SkillContent | null>;
  enforced: readonly EnforcedChatSkill[];
  /** The origin space, which owns the enforced skills. */
  origin?: { id: string; name: string };
}): RenderedContext {
  const skills = resolveChatSkills(opts.selection, opts.contents, opts.enforced);
  const files = SKILLS_FILES[opts.capabilities.transport ? "tool" : "none"];
  const injected = new Set(skills.enforced.map((skill) => skill.packageId));
  // A listed skill the turn cannot load is noise; `auto` lists, the others inject.
  const listed =
    opts.capabilities.readsSkills && !injectsSkills(opts.selection.skillMode)
      ? opts.catalogue.filter((skill) => !injected.has(skill.packageId))
      : [];
  const groups: string[][] = [];
  if (opts.selection.skillMode === "strict") groups.push([SKILLS_STRICT_NOTE]);
  if (opts.selection.skillMode === "manual" && opts.capabilities.readsSkills) {
    groups.push([SKILLS_MANUAL_NOTE]);
  }
  if (skills.enforced.length && opts.origin) {
    groups.push([
      `${enforcedLead(opts.origin)} ${files}`,
      ...skills.enforced.flatMap((s) => ["", skillBlock(s)]),
    ]);
  }
  if (listed.length) groups.push(listed.map(skillLine));
  if (skills.chosen.length) {
    groups.push([
      `${SKILLS_INJECTED_LEAD} ${files}`,
      ...skills.chosen.flatMap((s) => ["", skillBlock(s)]),
    ]);
  }
  if (skills.notices.length) groups.push(skills.notices);
  const text =
    groups.length === 0
      ? ""
      : [SKILLS_HEADING, ...groups.map((group) => group.join("\n"))].join("\n\n");
  return { text, injected: injectedSkills(skills) };
}

type CallerContextOpts = {
  locale?: string;
  now?: Date;
  capabilities: TurnCapabilities;
  rolePreview: boolean;
  /** The spaces the turn can act in: its calls name them (the origin space alone when limited). */
  spaces: readonly ReachableSpaceGrant[];
  /** The conversation's origin space, when it can act there: the default of a request naming none. */
  origin?: { id: string; name: string };
  /** Limited to the origin space: the turn's spaces are that space alone. */
  restricted: boolean;
  /** The TURN's set (post-`turnPermissions`): the authoring toggle narrows it. */
  permissions: readonly string[];
  skills: ChatSkillSelection;
  /** The chosen skills active here, read by {@link buildCallerContextBlock}. */
  skillContents?: ReadonlyMap<string, SkillContent | null>;
  /** The `auto` catalogue, listed by {@link buildCallerContextBlock}. */
  skillCatalogue?: readonly CatalogueSkill[];
  /** Required: a caller that forgot it would drop the origin space's required skills silently. */
  enforced: readonly EnforcedChatSkill[];
};

/** Render the caller context into a system-prompt block, with the skills it injected. */
export function formatCallerContext(
  identity: CallerIdentity,
  opts: CallerContextOpts,
): RenderedContext {
  const skills = formatSkillsSection({
    selection: opts.skills,
    capabilities: opts.capabilities,
    catalogue: opts.skillCatalogue ?? [],
    contents: opts.skillContents ?? new Map(),
    enforced: opts.enforced,
    origin: opts.origin,
  });
  const skillSection = skills.text;
  const name = identity.user.name?.trim();
  const email = identity.user.email?.trim();
  const role = identity.org.role?.trim();
  const orgName = identity.org.name?.trim();
  const orgSlug = identity.org.slug?.trim();

  const who = name && email ? `${name} (${email})` : (name ?? email ?? "the user");
  const orgLabel = orgName
    ? ` in the organization "${orgName}"${orgSlug ? ` (\`${orgSlug}\`)` : ""}`
    : "";
  const lines = [
    "## Your context",
    `You are assisting ${who}${role ? `, whose role is "${role}"` : ""}${orgLabel}.`,
  ];
  // The spaces the turn acts in, then the default of a request naming no space, never a pin:
  // the origin space, else the caller's personal space, else the organization's default space,
  // when the turn acts there (with none, the model asks). A limited conversation's spaces are
  // its origin alone, which every call still names. That a refused action is never moved to
  // another space is the server's instructions' (`NO_FALLBACK_HINT`), not repeated here.
  const preview = opts.rolePreview ? " (role preview active)" : "";
  const fallback = opts.origin
    ? undefined
    : (opts.spaces.find((space) => space.personal) ?? opts.spaces.find((space) => space.isDefault));
  lines.push(
    `Spaces you can act in${preview}; every tool that acts in a space takes the \`space_id\` of one of them:`,
    ...opts.spaces.map((space) => `- \`${space.id}\` — ${space.name} (role ${space.role})`),
    opts.restricted && opts.origin
      ? `This conversation is limited to ${opts.origin.name} (\`${opts.origin.id}\`): pass \`${opts.origin.id}\` as the \`space_id\` of every call; no other space can be reached. The user lifts the limit in the composer.`
      : opts.origin
        ? `This conversation was started in ${opts.origin.name} (\`${opts.origin.id}\`): when the user names no space, pass \`${opts.origin.id}\` as the \`space_id\`.`
        : fallback
          ? `When the user names no space, pass \`${fallback.id}\` (${fallback.name}, ${fallback.personal ? "your personal space" : "the organization's default space"}) as the \`space_id\`.`
          : "Ask the user which space when the request does not say; never guess it.",
  );
  // The set is the union over the spaces listed above: it bounds what the turn may attempt,
  // while each call is decided by the role held in the space it names. Permissions are in the
  // vocabulary of `required_permissions` and the 403 hint, so the model joins the two.
  lines.push(
    `Permissions this turn (the union over the spaces listed above; each call is decided in the space it names, by your role there): ${
      opts.permissions.length > 0 ? [...opts.permissions].sort().join(", ") : "none"
    }`,
  );
  // Ground "today" from the server clock. The chat carries no browser-supplied
  // clock/timezone (none is persisted server-side), so this is always UTC.
  //
  // Rounded to the HOUR, and that number is load-bearing. This block sits in the
  // system prompt, which pi-ai emits as ONE text block carrying ONE
  // `cache_control` breakpoint (`anthropic-messages.js` — the non-OAuth branch
  // builds `params.system` as a single entry). A breakpoint covers the whole
  // block, so ANY per-turn difference invalidates the entire cached prefix —
  // and, because caching is prefix-based, the conversation-history breakpoint
  // downstream of it with it. The ephemeral retention is 5 minutes, so an
  // hour-granular clock is stable across every window a cache entry can live
  // in, while still grounding the model to the right hour. A minute-granular
  // clock (what this used to be) misses on any turn that crosses a minute —
  // i.e. most interactive turns.
  //
  // `opts.now` exists so the stability invariant is testable without fake timers.
  const now = new Date(opts.now ?? Date.now());
  now.setUTCMinutes(0, 0, 0);
  lines.push(`Current date and time: ${now.toISOString()} (UTC, rounded to the hour).`);
  // UI language forwarded by the client (`X-Chat-Locale`), defaulting to the
  // platform's default locale (fr) when absent.
  lines.push(
    `Reply in the user's language (${normalizeChatLocale(opts.locale)}) unless they switch.`,
  );
  // Rendered whatever the authoring grant: the chat uses skills for itself.
  if (skillSection) lines.push("", skillSection);
  // Neither the connected integrations, the runnable agents nor the recent runs are rendered: they
  // differ per space, and the last rewrites itself on every launch, busting the system prompt's
  // single cache breakpoint. The model reads them with the tools, for the space concerned.
  return { text: lines.join("\n"), injected: skills.injected };
}

/**
 * What the chat reads a turn's skills through: a platform MCP connection
 * with the caller's own permissions and no injected-skills claim, closed once
 * they are read.
 */
export type ChatSkillsClient = Pick<AppstrateMcpClient, "listSkills" | "readResource" | "close">;

/**
 * The entries of a `skills/list` that sit in one of `spaces`, one per package: the one in the
 * first of `spaces` that lists it (the turn's spaces, in the order `GET /api/spaces` uses).
 */
function entriesByPackage(
  entries: readonly ListedSkillEntry[],
  spaces: readonly string[],
): Map<string, ListedSkillEntry> {
  const byPackage = new Map<string, { entry: ListedSkillEntry; rank: number }>();
  for (const entry of entries) {
    const spaceId = parseSkillUri(entry.uri)?.spaceId;
    const rank = spaceId === undefined ? -1 : spaces.indexOf(spaceId);
    const pkg = parseSkillUriPackage(entry.uri);
    if (rank === -1 || !pkg) continue;
    const kept = byPackage.get(pkg.packageId);
    if (!kept || rank < kept.rank) byPackage.set(pkg.packageId, { entry, rank });
  }
  return new Map([...byPackage].map(([packageId, { entry }]) => [packageId, entry]));
}

/**
 * Deadline of a turn's skills read, connection included: the preamble runs
 * before the turn's abort controller exists, and a client disconnect never
 * cancels a turn, so the read carries its own bound. Past it, the turn goes on
 * with the skills read so far left out, each with its notice.
 */
const SKILLS_READ_TIMEOUT_MS = 10_000;

/** The chosen skills' contents and the `auto` catalogue of a turn. */
interface ChatSkillsRead {
  contents: Map<string, SkillContent | null>;
  catalogue: CatalogueSkill[];
}

/**
 * The skills of a turn, read over the MCP Skills extension (SEP-2640): a skill
 * is the caller's draft when `skills/list` lists it among the drafts the caller
 * may read, else its published version. With `catalogue`, every such skill of
 * `spaces` is listed by its `uri` (one entry per package, the first space's); each of `chosen` is injected as the text
 * `resources/read` serves at its entry's URI. Read with the caller's own
 * permissions, even in `strict`, whose turn holds no `skills:*`. A chosen skill
 * in neither list, or whose read is refused, is left out; a malformed answer (a
 * draft entry without `lock_version`, a `SKILL.md` served as a blob, or text
 * whose digest differs from the one its entry lists) is kept as `null`, for its
 * own notice. The catalogue names a draft only with `catalogueDrafts` (the turn
 * itself may read the drafts the caller reads), so every URI it lists is one the
 * turn's `read_resource` reads. The connection is opened only when there is
 * something to read.
 */
async function readChatSkills(
  openSkillsClient: (signal: AbortSignal) => Promise<ChatSkillsClient>,
  spaces: readonly string[],
  opts: { catalogue: boolean; catalogueDrafts: boolean; chosen: readonly string[] },
): Promise<ChatSkillsRead> {
  const read: ChatSkillsRead = { contents: new Map(), catalogue: [] };
  if (!opts.catalogue && opts.chosen.length === 0) return read;
  const signal = AbortSignal.timeout(SKILLS_READ_TIMEOUT_MS);
  let client: ChatSkillsClient;
  try {
    client = await openSkillsClient(signal);
  } catch (err) {
    logger.warn("skills connection unavailable — the turn's skills left out", {
      err: String(err),
    });
    return read;
  }
  try {
    const list = (meta?: Record<string, unknown>) =>
      client.listSkills(meta ? { meta, signal } : { signal }).then(
        ({ skills }) => entriesByPackage(skills, spaces),
        (err: unknown) => {
          logger.warn("skills/list failed — its skills left out of the turn", {
            definition: meta ? "draft" : "published",
            err: String(err),
          });
          return new Map<string, ListedSkillEntry>();
        },
      );
    const [published, drafts] = await Promise.all([
      list(),
      list({ [SKILL_DEFINITION_META_KEY]: "draft" }),
    ]);
    if (opts.catalogue) {
      // A draft stands for its package's published version: one line per skill.
      const catalogueDrafts = opts.catalogueDrafts ? drafts : new Map<string, ListedSkillEntry>();
      const listed = new Map([...published, ...catalogueDrafts]);
      read.catalogue = [...listed.keys()].sort().map((packageId) => {
        const entry = listed.get(packageId)!;
        const served = servedAs(entry, catalogueDrafts.has(packageId));
        return {
          packageId,
          description: entry.frontmatter.description,
          version: served?.definition === "published" ? served.version : null,
          uri: entry.uri,
        };
      });
    }
    await Promise.all(
      opts.chosen.map(async (id) => {
        const entry = drafts.get(id) ?? published.get(id);
        if (!entry) return;
        const content = await client.readResource({ uri: entry.uri }, { signal }).then(
          ({ contents }) => contents.find((item) => item.uri === entry.uri),
          (err: unknown) => {
            logger.warn("resources/read of a chosen skill failed — left out", {
              uri: entry.uri,
              err: String(err),
            });
            return undefined;
          },
        );
        if (!content) return;
        const served = servedAs(entry, drafts.has(id));
        // A `SKILL.md` served as a blob is not a skill's text, and text that is
        // not the listed `SKILL.md` (a draft saved between the list and the
        // read) is not the definition the claim pins: both get their own notice.
        read.contents.set(
          id,
          served &&
            "text" in content &&
            typeof content.text === "string" &&
            isListedSkillMd(entry, content.text)
            ? {
                packageId: id,
                version: served.definition === "published" ? served.version : null,
                uri: entry.uri,
                content: content.text,
                served,
              }
            : null,
        );
      }),
    );
    return read;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Whether `text` is the `SKILL.md` its entry lists: its UTF-8 bytes have the listed `digest`. */
function isListedSkillMd(entry: ListedSkillEntry, text: string): boolean {
  // A `dynamic` entry lists no digest to check the text against.
  if (entry.resources === "dynamic") return false;
  const listed = entry.resources.find((resource) => resource.uri === entry.uri);
  return listed?.digest === skillFileDigest(text);
}

/**
 * The claim entry of a served skill — a draft pinned to the `lock_version` its
 * entry carries, a published skill to its `metadata.version` — or `null` for a
 * draft entry without one.
 */
function servedAs(entry: ListedSkillEntry, draft: boolean): SkillContent["served"] | null {
  const spaceId = parseSkillUri(entry.uri)?.spaceId;
  if (spaceId === undefined) return null;
  if (draft) {
    const lockVersion = entry._meta?.[SKILL_LOCK_VERSION_META_KEY];
    return Number.isSafeInteger(lockVersion)
      ? { definition: "draft", lockVersion: lockVersion as number, spaceId }
      : null;
  }
  const version = (entry.frontmatter.metadata as { version?: unknown } | undefined)?.version;
  return {
    definition: "published",
    version: typeof version === "string" ? version : null,
    spaceId,
  };
}

/**
 * Build the caller-context system-prompt block: the identity, the spaces the turn can
 * act in (the acting set, the origin space alone when the conversation is limited) with the
 * origin space as the default, when there is one, and the turn's permissions. Built from the
 * already-authenticated request context, with no read of the platform: the integrations and
 * the agents differ per space, so the model looks them up with its tools. The skills are
 * those of the turn's spaces, one per package (the first in reach order), each bound in the
 * claim to the space its URI names; the enforced ones are the origin space's. A rejected
 * `enforced` rejects the block: the turn is refused rather than run without them.
 */
export async function buildCallerContextBlock(
  c: Context<ChatEnv>,
  args: {
    /** The spaces the turn can act in: the acting set, or the origin space alone when limited. */
    spaces: readonly ReachableSpaceGrant[];
    /** The conversation's origin space, when it is one of `spaces`. */
    origin?: { id: string; name: string };
    /** Limited to the origin space. */
    restricted: boolean;
    user: { id: string; name?: string | null; email?: string | null };
    /** UI language forwarded by the client (`X-Chat-Locale`); defaults to fr. */
    locale?: string;
    capabilities: TurnCapabilities;
    permissions: readonly string[];
    skills: ChatSkillSelection;
    /** Already loading; a rejection rejects the block. */
    enforced: Promise<readonly EnforcedChatSkill[]>;
    /** Opened only when the turn lists or injects skills, under `signal`; closed once they are read. */
    openSkillsClient: (signal: AbortSignal) => Promise<ChatSkillsClient>;
  },
): Promise<{ text: string; injected: InjectedSkills }> {
  const { user, locale, capabilities, skills } = args;
  // The persona's while previewing: this block tells the model what the caller
  // may do, and every operation it names is checked against the persona.
  const persona = c.get("viewAs");
  const identity: CallerIdentity = {
    user: { name: user.name ?? null, email: user.email ?? null },
    org: {
      role: persona?.orgRole ?? c.get("orgRole") ?? null,
      name: c.get("orgName") ?? null,
      slug: c.get("orgSlug") ?? null,
    },
  };
  const injects = injectsSkills(skills.skillMode);
  const [turnSkills, enforced] = await Promise.all([
    readChatSkills(
      args.openSkillsClient,
      args.spaces.map((space) => space.id),
      {
        catalogue: capabilities.readsSkills && !injects,
        // The drafts the caller reads are the turn's only while the turn keeps the
        // caller's `skills:write` (the authoring switch drops it).
        catalogueDrafts: args.permissions.includes("skills:write"),
        chosen: injects ? skills.pinnedSkills : [],
      },
    ),
    args.enforced,
  ]);
  const { text, injected } = formatCallerContext(identity, {
    locale,
    capabilities,
    rolePreview: persona !== undefined,
    permissions: args.permissions,
    spaces: args.spaces,
    origin: args.origin,
    restricted: args.restricted,
    skills,
    skillContents: turnSkills.contents,
    skillCatalogue: turnSkills.catalogue,
    enforced,
  });
  // What `resources/read` serves without `skills:*`: each skill in the space its URI names.
  return { text, injected: { skills: injected } };
}
