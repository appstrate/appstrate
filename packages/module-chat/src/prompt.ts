// SPDX-License-Identifier: Apache-2.0

/**
 * Chat system-prompt construction: the static tool-grounding prompt, the caller
 * context (`GET /api/me/context`) rendering, and its assembler. Split out of
 * `chat-stream.ts` so prompt authoring lives apart from stream orchestration.
 *
 * The prompt deliberately does NOT restate the cross-cutting guidance the
 * platform MCP server already sends via its `instructions` (async runs, the
 * run_and_wait shortcut, integration selection/preference, connect-before-run,
 * heavy-list projection). The chat engine already receives that server text
 * through its own MCP handshake, so duplicating it here only lets the two
 * drift. Keep only
 * chat-specific value: persona, the operation-vs-agent decision tree, the inline
 * manifest authoring pattern, and how to consume a run's result.
 */

import type { Context } from "hono";
import { CONTEXT_FREE_FILENAMES_PHRASE } from "@appstrate/core/naming";
import {
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  SKILL_URI_PREFIX,
  parseSkillUriPackage,
  skillFileDigest,
} from "@appstrate/core/skill-uri";
import type { AppstrateMcpClient, ListedSkillEntry } from "@appstrate/mcp-transport";
import type { PrincipalKind } from "@appstrate/core/module";
import type { EnforcedChatSkill, InjectedSkills } from "@appstrate/core/chat-contract";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  type ConnectionResolutionWarningCode,
} from "@appstrate/core/integration";
import { logger } from "./logger.ts";
import { reaches, type TurnCapabilities } from "./capabilities.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";
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

/** Structural mirror of `SpaceRoleRef` (`apps/api/src/lib/space-role.ts`) — not importable from here. */
type SpaceRoleRefLike =
  | { kind: "preset"; preset: string }
  | { kind: "custom"; role: { id: string; name?: string | null } };

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
     * Space the router entered (`enterSpaceContext`, mounted on every
     * `/api/chat/*` route). Always set: entering is what makes the space-level
     * `chat:*` guards satisfiable, and a caller that names no space is refused
     * there before any handler runs.
     */
    space: { id: string };
    orgRole?: string;
    /**
     * Role preview (`X-View-As`), as the platform resolved it. `orgRole` is the
     * only field this module reads; the `Record` half is deliberate — the WHOLE
     * value is copied into the signed loopback claims, so the trust-boundary
     * payload is wider than what is read here. `orgRole` above stays REAL.
     */
    viewAs?: { orgRole: string } & Record<string, unknown>;
    /** Role in THIS space, under any persona (whose own `space` half may name another). */
    spaceRole?: SpaceRoleRefLike;
    orgName?: string;
    orgSlug?: string;
    /**
     * Caller's resolved RBAC permission set. Always set, for the same reason
     * `space` above is: entering the space is what writes it, and every
     * `/api/chat/*` route enters one before a handler runs. Two things read it,
     * and both need the whole set — the scoped platform-MCP bearer the Pi engine
     * hands its external binary (so the meta-tools authorize with exactly the
     * caller's own permissions, no amplification), and the container ACL of an
     * `appfile://` attachment.
     */
    permissions: Set<string>;
  };
};

// Named by the persona and rendered by the context block: one string for both.
const SKILLS_HEADING = "## Skills";
const SKILLS_ENFORCED_LEAD =
  "This space requires these skills in every conversation. Each is a procedure for YOU: follow it whenever it applies; where it conflicts with a skill the user chose, it wins.";
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
  "This conversation is restricted to the skills shown here — those the space requires and those the user chose, if any: that is why this turn holds no `skills:*` permission, whatever the user's role. Any listing therefore shows no skill, whatever the space holds — an empty result says nothing about it. The user lifts only their own restriction, by switching this conversation's skill mode in the composer; the space's requirement stays. Do not look for, list, load or write any other skill, and never change a role or a permission to reach one.";

/**
 * Instructions for an act the turn cannot perform are ABSENT rather than
 * contradicted, so the persona agrees with the tools the turn's token is shown;
 * the platform, not this text, refuses the act.
 */
export function buildSystemPrompt(capabilities: TurnCapabilities): string {
  const { invokes, authors, authorsPackages, readsSkills } = capabilities;
  const mayRun = reaches(capabilities.runLevel, "run");
  const mayRead = reaches(capabilities.runLevel, "read");
  const mayCompose = reaches(capabilities.runLevel, "compose");
  const runs = (yes: string, no = "") => (mayRun ? yes : no);
  const reads = (yes: string, no = "") => (mayRead ? yes : no);
  const inline = (yes: string, no = "") => (mayCompose ? yes : no);
  const author = (yes: string, no = "") => (authors ? yes : no);
  const invoke = (yes: string, no = "") => (invokes ? yes : no);
  const skills = (yes: string, no = "") => (readsSkills ? yes : no);
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
  // Only a list the context renders: the route of one never shown may refuse.
  const truncatedListBullet = runs(
    '- A list marked `(list truncated)` is partial: call `invoke_operation` with `operation_id: "listAgents"` for the full one.\n',
  );
  return `You are Appstrate's assistant. You help the user operate their Appstrate instance through the available tools.

**You have no ability of your own to act on the outside world.** You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is ${invoke("invoking Appstrate operations", "looking Appstrate's own operations up and reading what it already exposes to you")}.${runs(" You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.", " Never claim to have carried out an action external to Appstrate yourself.")}

Use the tools to ground every action. For ordinary Appstrate API work, ${invoke(
    "search for the right operation with `search_operations`, read its schema with `describe_operation`, then invoke it with `invoke_operation`",
    "search for the right operation with `search_operations` and read its schema with `describe_operation`: you can look things up, you cannot act — answer the user from what you read, and never claim to have carried an operation out",
  )}.${runs(` When you need a newly launched run's progress or result in this turn, prefer calling \`run_and_wait\` directly: it owns launch plus waiting and already declares its argument schema. ${inline("The `runAgent` and `runInline` operations remain", "The `runAgent` operation remains")} available through \`describe_operation\` and \`invoke_operation\` when you intentionally need fire-and-forget semantics.`)} Never invent an operationId or argument shape.

Choosing what to do:
${invoke(
  `- If the request is a pure Appstrate operation, call that operation directly with \`invoke_operation\`; the permissions listed in your context decide what you may call, so never name an act they do not carry.${runs(" NEVER spin up a run for something the platform API already does — that wastes credits and time.")}\n${
    authorsPackages
      ? "- To create a package — an agent, a skill, an integration or a local MCP server — call its type's create operation (`createAgent`, `createSkill`, `createIntegrationPackage`), reading its schema with `describe_operation` first. A local MCP server embeds its code, so it is created only by importing an archive with `import_package_file`, which also imports a package of any other type. When a skill listed in your context guides authoring that type, load it before writing anything.\n"
      : "- Do not create, import or modify any package (agent, skill, integration, MCP server) in this turn, not even through `invoke_operation`.\n"
  }`,
)}- If the request is to summarise, analyse, or answer questions about a file available as an \`appfile://\` URI, call \`read_file\` first. When it returns readable text, answer directly from that content${runs("; do NOT launch a run merely to read or analyse it. Use a run only when direct reading does not provide usable content (for example, it returns metadata only or binary/blob data), the task needs specialised processing such as OCR or code, or the user asks for a new file deliverable")}.
${runs(
  `- If the request needs external information or context and names no source, default to the integrations already available to the user — connected ones first, then ones activated for this space — rather than answering from memory or asking which source to use. Ask only when no available integration plausibly covers the need.
- If the request needs an integration, an MCP, or any external action, run an agent:
  1. Prefer an existing agent the user can run (listed in your context below) when one matches the intent — call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` (KEEP the leading \`@\`, e.g. \`@acme\`) and \`name\`. Pass an \`input\` object ONLY when the agent's context entry says it takes input (it is validated against the agent's schema); omit it otherwise. \`version\`: omit it to run the latest PUBLISHED version. An agent marked "draft only, yours to run" has no published version but the user authors it, so pass \`version:"draft"\` for those. An agent marked "draft only, not runnable" has no published version and the user does not author it — it CANNOT be run at all (omitting 404s \`no_published_version\`, \`version:"draft"\` 403s \`draft_not_writable\`); say so and ${inline("offer to compose an inline agent instead", "stop — there is no other way to run it")}.
${inline(
  `  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`: pass a PARTIAL canonical AFPS agent \`manifest\` plus a top-level \`prompt\`. Give EVERY inline run a task-specific identity: set \`manifest.display_name\` to a concise human title in the user's language that describes the exact action or outcome of THIS run (for example, "Analyse des 3 derniers e-mails"). The platform derives the matching \`@inline/<kebab-case-slug>\` name and fills omitted AFPS boilerplate, \`runtime_tools\` (log, output, publish_file), and an open object output schema. Defaults apply ONLY to absent top-level fields: every field you provide replaces its default exactly, arrays and nested objects are never merged, and \`runtime_tools: []\` stays empty. You can override EVERY field — including \`name\`, \`runtime_tools\`, and a complete strict \`output.schema\` — when the task needs a complex deterministic manifest; if you provide a non-empty output schema, your explicit runtime tools must include \`output\`. Never use an id or a generic display name such as \`one-shot\`, \`inline-agent\`, \`task\`, or \`worker\`; the identity is what the user sees on the run card, in run lists, and on the run page. In the manifest, declare the integration(s) under \`dependencies.integrations\` (use the exact \`@scope/name\` id and version from your context), then select that integration's tools under \`integrations_configuration.<id>.tools\`: list the exact tool names the task needs (\`api_call\` covers most third-party REST calls); omit the entry to inherit the integration's \`default_tools\` (shown per integration in your context) only when the task needs that whole default. A run can call, and loads the schema of, every tool it is given, so never give it more than the task needs. When your context does not show a name you need (a tool beyond the default, or a default shown as a count), read the integration with \`invoke_operation\` (\`operation_id: "getIntegration"\`, \`GET /api/integrations/{packageId}\`): its \`default_tools\` holds the default's names, its \`tool_catalog\` every tool you may select. Then name those tools. A declared integration is optional: without a usable connection the run starts without it and lists it in \`warnings\`. Set \`integrations_configuration.<id>.required: true\` when the task means nothing without it, to refuse the launch instead.${skills(' When one of the skills listed in your context fits the task, attach it under `dependencies.skills` keyed by its `@scope/name` id with a satisfiable range (use the version shown in your context, e.g. `"^1.2.0"`, or `"*"` if none); the agent then has that skill\'s instructions available.')} In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with \`log\`, do the work, then return the result with \`output\` as its mandatory last action.

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
  "prompt": "You are a sub-agent. Log meaningful progress with the log tool. Fetch the user's 3 most recent emails, summarise them, and return the summary by calling the output tool."
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

After a successful \`run_and_wait\`, deliver the result directly and briefly: present the \`result\` content (formatted for readability) and stop. Do not narrate what the run did, restate its progress logs, or add closing commentary — the user watched the run live on its card. One short lead-in sentence at most. One exception: each \`warnings\` item (${CONNECTION_RESOLUTION_WARNING_CODES.map(warningCode).join(", ")}; \`field: "integrations.<id>"\`) names an integration the run started without, so the result lacks what it would have provided. Say so in one sentence per integration and never present the result as covering that source. For ${warningCode("not_connected")} or ${warningCode("auth_key_mismatch")}, offer to connect it when a connect card appears under the run. For ${warningCode("must_choose_connection")}, only colleagues' shared connections exist: offer a re-run with the one the user names among its \`candidate_connections\`. For ${warningCode("integration_unbound")}, a connection choice (its \`source\`) binds none on purpose: say so, and offer nothing to connect. For ${warningCode("integration_not_active")}, connecting is not the remedy: the integration is not activated in this space, which someone allowed to manage the space fixes by activating it (\`activatePackage\`, below) — offer that, and do not re-run unless the user asks.

`,
  "\n",
)}${reads(`Never quote run metrics — duration, cost, token usage — in your replies, even when a run resource you read carries them: the chat UI already displays them on the run card. Report only what the run produced (its result) or why it failed (its error).

`)}When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.${runs(` One failure is never fixed by retrying, but has a direct remedy: an \`integration_not_active\` error on \`integrations.<id>\` means the integration is connected but not activated for this space — do NOT re-run and do NOT restart the connect flow (connecting is personal, activating is per space). Activate it instead: call \`activatePackage\` (\`POST /api/spaces/{spaceId}/packages\`, with \`spaceId\` the current space from your context block and the body \`{ "packageId": "<that integration id>" }\`), then re-run once. If that call is refused, report the refusal with its error and stop.`)}

Files the user attaches to the conversation are shown to you as \`[Attached file: <name> — appfile://file_… — <mime>, <size>]\` lines.${runs(` Follow the direct-reading rule above before considering a run. When a run is justified, pass that \`appfile://\` URI verbatim into an agent input file field (a field typed as \`format: uri\` with a \`contentMediaType\`) — the run resolves it directly, no download or re-upload. \`upload://\` URIs work the same way. A published agent's input schema is a versioned contract the platform never rewrites, so a \`kind:"agent"\` run takes a file only through \`run_and_wait\`'s \`input\`, under one of the agent's DECLARED file fields.`)}${inline(` For an INLINE run, declare nothing: list the \`appfile://\` URIs in \`run_and_wait\`'s top-level \`context_files\` and the platform mounts them read-only under \`files/\` and announces them in the run's prompt — that is the cheap path, use it. Declaring the file field yourself in the manifest's \`input.schema\` (\`{"type":"string","format":"uri","contentMediaType":"<mime>"}\`) plus a top-level \`input\` also works. \`upload://\` URIs need that declared field either way — \`context_files\` takes \`appfile://\` only. Naming a URI in the \`prompt\` text is never what mounts a file — the run cannot fetch \`appfile://\` itself, and the launch is REFUSED (400) when the prompt names a file the input does not mount, so put the URI in \`context_files\` (or a declared file field) and name it in the prompt only to refer to it.`)} Never invent an \`appfile://\` URI.

${runs(`Everything a run writes under \`outputs/\` is published when it ends: the files appear on the run's page, come back in the \`run_and_wait\` result's \`files\` list, and render as downloadable chips in this chat. Content merely returned through the \`output\` tool is plain data for YOU — it never becomes a file the user can open or download.${inline(` So when the user asks for a file or downloadable deliverable (a report, a CSV, an image, a PDF…), instruct the sub-agent, in its \`prompt\`, to WRITE it as a file into the \`outputs/\` directory of its workspace (creating it if needed). Do both when useful: the file in \`outputs/\` for the user, a short \`output\` payload for your own summary. Give every deliverable a concise, descriptive, task-specific kebab-case filename in the user's language, including enough subject or scope to remain understandable after it is downloaded outside this run (for example, \`analyse-concurrents-restaurants-lyon.md\`). NEVER use context-free names such as ${CONTEXT_FREE_FILENAMES_PHRASE}. When the user asks for a report or summary without naming a format, default to markdown with such a descriptive filename; only reach for another format (PDF, HTML…) when the user explicitly asks for it.`)}

`)}Your context block below is DATA — the user's identity and role, the current date, the integrations they have connected${runs(", the agents they can run")}${skills(", and the skills available")}. How to act on it:
- Use the current date to resolve relative dates.
${idVerbatimBullet}${runs(`- ${inline("Prefer running an existing agent over doing the work inline when one fits the task", "Run an existing agent whenever one fits the task")}. Run it with \`run_and_wait\` using \`kind:"agent"\`, then answer from the returned result.
`)}${skills(`- The skills under \`${SKILLS_HEADING}\` are guides for YOU — procedures you follow yourself, not packages you run. One shown in full, inside a \`<skill>\` tag, is already loaded: follow it. When one listed only by its id and \`skill://\` URI clearly matches the request, LOAD IT BEFORE acting: call \`read_resource\` with that URI verbatim, then follow the SKILL.md it returns. Load ONE at a time, and none when none clearly matches. Never load a skill whose content already appears in this conversation. To read a file a skill references, call \`read_resource\` with the skill's URI, replacing \`SKILL.md\` with the file's path.
`)}${skills(
    author(`- Skills are not run on their own. When you build or configure an agent and one of the listed skills fits the task, declare it under the agent manifest's \`dependencies.skills\` keyed by its id (e.g. \`"@appstrate/web-research": "^1.2.0"\`) — use the version shown, or \`"*"\` if none. The run route validates that declared skills exist.
`),
  )}${truncatedListBullet}${reads(`- The context carries NO run history. When the user asks about a recent or failed run${runs(", or wants to re-run something")}, without naming it, call \`listRuns\` (newest first) before answering, then fetch full details with the run get operation when needed.
`)}
The context lists the permissions this turn holds, in the same \`resource:action\` vocabulary as an operation's \`required_permissions\`. An operation that needs one outside that list is refused by the platform: say which permission is missing${invoke(" instead of attempting it")}, and never claim an ability the list does not carry.`;
}

/** Shape of GET /api/me/context (the `get_me` payload). Validated loosely. */
interface CallerContext {
  user?: { name?: string | null; email?: string | null } | null;
  org?: { role?: string | null; name?: string | null; slug?: string | null } | null;
  connections?:
    | {
        integration_package_id: string;
        name: string;
        source: string;
        version?: string;
        default_tools?: readonly string[] | "*" | null;
      }[]
    | null;
  agents?:
    | {
        packageId: string;
        display_name?: string | null;
        description?: string | null;
        takes_input?: boolean | null;
        /** False = draft-only agent: no published version to run. */
        published?: boolean | null;
        /**
         * Whether the CALLER may write the agent, i.e. whether its draft is
         * theirs to run. Read together with `published`: unpublished and not
         * writable is an agent nobody but its author can execute, and telling
         * the model to "run with version=draft" there buys a 403 loop.
         */
        home_writable?: boolean | null;
      }[]
    | null;
  agents_truncated?: boolean | null;
}

/** Longest `default_tools` list rendered by name; a longer one is rendered as its count. */
const MAX_LISTED_DEFAULT_TOOLS = 12;

/**
 * Render an integration's AFPS §4.4 `default_tools` for the caller-context
 * line. `"*"` → all tools; a non-empty array → the names, or their count past
 * {@link MAX_LISTED_DEFAULT_TOOLS} (the line is repeated per connection on
 * every turn); anything else (absent, empty, null) → an explicit "no default"
 * so the model knows it must select tools itself rather than relying on
 * inheritance.
 */
function formatConnectionDefaultTools(d: readonly string[] | "*" | null | undefined): string {
  if (d === "*") return "default: all tools";
  if (Array.isArray(d) && d.length > MAX_LISTED_DEFAULT_TOOLS) {
    return `default: ${d.length} tools (names: \`default_tools\` of \`getIntegration\`)`;
  }
  if (Array.isArray(d) && d.length > 0) return `default: ${d.join(", ")}`;
  return "no default — you must select tools explicitly";
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

/**
 * `home_writable` follows the role preview (`/api/me/context` gets `x-view-as`)
 * but not the authoring toggle, which narrows only the minted token.
 */
function draftOnlyHint(input: {
  homeWritable: boolean;
  author: boolean;
  rolePreview: boolean;
}): string {
  if (!input.homeWritable) {
    return input.rolePreview
      ? "; draft only, not runnable under this role preview"
      : "; draft only, not runnable — nothing published and you do not author it";
  }
  if (input.author) return "; draft only, yours to run — pass version=draft";
  return "; draft, not runnable in this turn — this turn does not hold agent authoring";
}

/** A rendered block (or section) and the skills it injected, which the turn's MCP bearer names. */
interface RenderedContext {
  text: string;
  injected: InjectedSkillMap;
}

/**
 * `## Skills`, or "". Kept apart so {@link buildCallerContextBlock} appends it on
 * every path: the space's skills never depend on `/api/me/context` answering.
 */
function formatSkillsSection(opts: {
  selection: ChatSkillSelection;
  capabilities: TurnCapabilities;
  catalogue: readonly CatalogueSkill[];
  contents: ReadonlyMap<string, SkillContent | null>;
  enforced: readonly EnforcedChatSkill[];
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
  if (skills.enforced.length) {
    groups.push([
      `${SKILLS_ENFORCED_LEAD} ${files}`,
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
  spaceRole: string | null;
  spaceId?: string;
  /** The TURN's set (post-`turnPermissions`): the authoring toggle narrows it. */
  permissions: readonly string[];
  skills: ChatSkillSelection;
  /** The chosen skills active here, read by {@link buildCallerContextBlock}. */
  skillContents?: ReadonlyMap<string, SkillContent | null>;
  /** The `auto` catalogue, listed by {@link buildCallerContextBlock}. */
  skillCatalogue?: readonly CatalogueSkill[];
  /** Required: a caller that forgot it would drop the space's skills silently. */
  enforced: readonly EnforcedChatSkill[];
};

/**
 * Render the caller context into a system-prompt block, "" when the payload is
 * unusable so the caller can skip injection, with the skills it injected.
 */
export function formatCallerContext(raw: unknown, opts: CallerContextOpts): RenderedContext {
  const author = opts.capabilities.authors;
  const runnable = reaches(opts.capabilities.runLevel, "run");
  const ctx = (raw ?? {}) as CallerContext;
  // Before the emptiness check: a payload holding only skills deserves a block.
  const skills = formatSkillsSection({
    selection: opts.skills,
    capabilities: opts.capabilities,
    catalogue: opts.skillCatalogue ?? [],
    contents: opts.skillContents ?? new Map(),
    enforced: opts.enforced,
  });
  const skillSection = skills.text;
  const name = ctx.user?.name?.trim();
  const email = ctx.user?.email?.trim();
  const role = ctx.org?.role?.trim();
  const orgName = ctx.org?.name?.trim();
  const orgSlug = ctx.org?.slug?.trim();
  if (
    !name &&
    !email &&
    !role &&
    !orgName &&
    !ctx.connections?.length &&
    !ctx.agents?.length &&
    !skillSection
  )
    return { text: "", injected: skills.injected };

  const who = name && email ? `${name} (${email})` : (name ?? email ?? "the user");
  const orgLabel = orgName
    ? ` in the organization "${orgName}"${orgSlug ? ` (\`${orgSlug}\`)` : ""}`
    : "";
  const lines = [
    "## Your context",
    `You are assisting ${who}${role ? `, whose role is "${role}"` : ""}${orgLabel}.`,
  ];
  // Permissions in the vocabulary of `required_permissions` and the 403 hint, so
  // the model joins the two; space-scoped operations take the space in their PATH.
  if (opts.spaceId) lines.push(`Current space: \`${opts.spaceId}\``);
  if (opts.spaceRole) {
    lines.push(
      `Role in this space: ${opts.spaceRole}${opts.rolePreview ? " — role preview active" : ""}`,
    );
  }
  lines.push(
    `Permissions this turn: ${
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
  if (ctx.connections?.length) {
    // Render the exact package id (and version when known) so the model can use
    // it verbatim in an inline run's `dependencies.integrations` without a
    // discovery round-trip — the display name alone forced a lookup detour.
    const list = ctx.connections
      .map((c) => {
        const ver = c.version ? `@${c.version}` : "";
        return `${c.name} — \`${c.integration_package_id}\`${ver} (${c.source}; ${formatConnectionDefaultTools(c.default_tools)})`;
      })
      .join(", ");
    // Render the connected integrations as data only — the `@scope/name` id (+
    // version) the model uses verbatim. The preference order (connected >
    // activated > inactive) and the default-vs-tool_catalog selection rule live
    // once in the platform MCP server instructions (apps/api/src/modules/mcp/
    // router.ts), which the engine already receives through its own MCP
    // handshake; don't restate them here or the two drift. The "use the id
    // verbatim" instruction lives in `buildSystemPrompt` for the same reason — see
    // the block-wide rule below.
    lines.push(
      author
        ? `Integrations the user has connected and could attach to an agent: ${list}.`
        : `Integrations the user has connected: ${list}.`,
    );
  } else {
    lines.push("The user has no connected integrations yet.");
  }
  // No launch, no section: better absent than every entry marked unreachable.
  if (ctx.agents?.length && runnable) {
    lines.push("", "## Existing agents you can run");
    for (const a of ctx.agents) {
      const desc = a.description?.trim();
      const label = a.display_name?.trim() || a.packageId;
      lines.push(
        `- \`${a.packageId}\` — ${label}${desc ? `: ${desc}` : ""}` +
          ` (takes input: ${a.takes_input ? "yes" : "no"}` +
          `${
            a.published === false
              ? draftOnlyHint({
                  homeWritable: a.home_writable === true,
                  author,
                  rolePreview: opts.rolePreview,
                })
              : ""
          })`,
      );
    }
    if (ctx.agents_truncated) lines.push("(list truncated)");
  }
  // Rendered whatever the authoring grant: the chat uses skills for itself.
  if (skillSection) lines.push("", skillSection);
  // `/api/me/context` also carries `recent_runs`, deliberately neither read nor rendered here: it
  // rewrites itself on every launch, busting the system prompt's single cache breakpoint.
  // `buildSystemPrompt` tells the model to call `listRuns` instead (when the turn reads runs).
  return { text: lines.join("\n"), injected: skills.injected };
}

/**
 * What the chat reads a turn's skills through: a platform MCP connection
 * with the caller's own permissions and no injected-skills claim, closed once
 * they are read.
 */
export type ChatSkillsClient = Pick<AppstrateMcpClient, "listSkills" | "readResource" | "close">;

/** The space's entries of a `skills/list`, by package id. */
function entriesByPackage(
  entries: readonly ListedSkillEntry[],
  spaceId: string,
): Map<string, ListedSkillEntry> {
  const byPackage = new Map<string, ListedSkillEntry>();
  for (const entry of entries) {
    if (!entry.uri.startsWith(`${SKILL_URI_PREFIX}${spaceId}/`)) continue;
    const pkg = parseSkillUriPackage(entry.uri);
    if (pkg) byPackage.set(pkg.packageId, entry);
  }
  return byPackage;
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
 * the space is listed by its `uri`; each of `chosen` is injected as the text
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
  spaceId: string,
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
        ({ skills }) => entriesByPackage(skills, spaceId),
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
  if (draft) {
    const lockVersion = entry._meta?.[SKILL_LOCK_VERSION_META_KEY];
    return Number.isSafeInteger(lockVersion)
      ? { definition: "draft", lockVersion: lockVersion as number }
      : null;
  }
  const version = (entry.frontmatter.metadata as { version?: unknown } | undefined)?.version;
  return { definition: "published", version: typeof version === "string" ? version : null };
}

/** The preset, or a custom bundle's name (its id when unnamed). */
function spaceRoleLabel(ref: SpaceRoleRefLike | undefined | null): string | null {
  if (!ref) return null;
  if (ref.kind === "preset") return ref.preset;
  return ref.role.name?.trim() || ref.role.id;
}

/** `GET /api/me/context`: the payload, `400` (the caller lost the space), or null. */
async function readCallerContext(
  deps: ChatPlatformDeps,
  origin: string,
  headers: Headers,
): Promise<CallerContext | 400 | null> {
  try {
    const res = await deps.dispatch(
      new Request(new URL("/api/me/context", origin).toString(), { headers }),
    );
    if (res.ok) return (await res.json()) as CallerContext;
    return res.status === 400 ? 400 : null;
  } catch (err) {
    logger.warn("me/context unavailable — chat degrades without caller context", {
      err: String(err),
    });
    return null;
  }
}

/**
 * Build the caller-context system-prompt block from `GET /api/me/context` — the
 * canonical assembler the platform MCP `get_me` tool also uses, so the chat
 * prompt and the MCP surface can never drift. Dispatched IN-PROCESS through the
 * platform app (auth + RBAC re-run on the dispatched Request), with a loopback
 * `fetch` fallback inside `deps.dispatch` for OSS/test wiring.
 *
 * `spaceId` is the space the chat router entered, so it is always known here.
 * A 400 from the dispatch (the caller lost the space between the entry and this
 * read) degrades to an identity-only block built from the already-authenticated
 * request context (name/email/role/org); any other failure degrades to the
 * skills section alone. Identity survives the first so date/role grounding
 * holds; the space's skills survive both. A rejected `enforced` rejects the
 * block: the turn is refused rather than run without them.
 */
export async function buildCallerContextBlock(
  c: Context<ChatEnv>,
  args: {
    origin: string;
    headers: Record<string, string>;
    spaceId: string;
    user: { id: string; name?: string | null; email?: string | null };
    deps: ChatPlatformDeps;
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
  const { origin, headers, spaceId, user, deps, locale, capabilities, skills } = args;
  // Bound to this space: `resources/read` honours the claim only for it.
  const claimed = ({ text, injected }: RenderedContext) => ({
    text,
    injected: { spaceId, skills: injected },
  });
  // The persona's while previewing: this block tells the model what the caller
  // may do, and every operation it names is checked against the persona.
  const persona = c.get("viewAs");
  const ctxHeaders = new Headers(headers);
  ctxHeaders.set("x-space-id", spaceId);
  const injects = injectsSkills(skills.skillMode);
  const [context, turnSkills, enforced] = await Promise.all([
    readCallerContext(deps, origin, ctxHeaders),
    readChatSkills(args.openSkillsClient, spaceId, {
      catalogue: capabilities.readsSkills && !injects,
      // The drafts the caller reads are the turn's only while the turn keeps the
      // caller's `skills:write` (the authoring switch drops it).
      catalogueDrafts: args.permissions.includes("skills:write"),
      chosen: injects ? skills.pinnedSkills : [],
    }),
    args.enforced,
  ]);
  const opts = {
    locale,
    capabilities,
    rolePreview: persona !== undefined,
    spaceRole: spaceRoleLabel(c.get("spaceRole")),
    spaceId,
    permissions: args.permissions,
    enforced,
  };
  if (context && context !== 400) {
    return claimed(
      formatCallerContext(context, {
        ...opts,
        skills,
        skillContents: turnSkills.contents,
        skillCatalogue: turnSkills.catalogue,
      }),
    );
  }
  // Degraded: nothing says which chosen skills are active here, so none is named,
  // but the mode (strict's note) and the space's skills stay.
  const unresolved: ChatSkillSelection = { skillMode: skills.skillMode, pinnedSkills: [] };
  if (context === 400) {
    // Identity/role straight off the request context.
    return claimed(
      formatCallerContext(
        {
          user: { name: user.name ?? null, email: user.email ?? null },
          org: {
            role: persona?.orgRole ?? c.get("orgRole") ?? null,
            name: c.get("orgName") ?? null,
            slug: c.get("orgSlug") ?? null,
          },
        },
        { ...opts, skills: unresolved },
      ),
    );
  }
  return claimed(
    formatSkillsSection({
      selection: unresolved,
      capabilities,
      catalogue: [],
      contents: new Map(),
      enforced,
    }),
  );
}
