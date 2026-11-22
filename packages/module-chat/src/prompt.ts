// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's system prompt: the persona (`buildSystemPrompt`) and the caller context block
 * (`buildCallerContextBlock`, rendered by `formatCallerContext`, with the skills it injects).
 *
 * Neither restates what the platform MCP server's `instructions` and tool descriptions already
 * send through the engine's own handshake (the space choice order and its refusals, integration
 * preference, async runs, launch warnings, the inline manifest, connection overrides): a second
 * copy only drifts. The context block states facts only, never a rule. Only chat-specific
 * guidance lives here.
 */

import type { Context } from "hono";
import {
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  parseSkillUri,
  parseSkillUriPackage,
  skillFileDigest,
} from "@appstrate/core/skill-uri";
import type { AppstrateMcpClient, ListedSkillEntry } from "@appstrate/mcp-transport";
import type { PrincipalKind, ReachableSpaceGrant } from "@appstrate/core/module";
import type { InjectedSkills } from "@appstrate/core/chat-contract";
import { platformToolName } from "@appstrate/core/integration";
import { logger } from "./logger.ts";
import { reaches, type TurnCapabilities } from "./capabilities.ts";
import {
  injectedSkills,
  MAX_PINNED_SKILLS,
  resolveChatSkills,
  type ChatSkillSelection,
  type PinnedSkillStatus,
  type SkillContent,
} from "./skills.ts";

type InjectedSkillMap = InjectedSkills["skills"];

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
// The turn's MCP bearer names every injected definition, so `resources/read`
// serves exactly its files, whatever `skills:*` — but only over the transport.
const SKILLS_FILES = {
  tool: "Only each SKILL.md is shown: read a file it references with `read_resource`, replacing `SKILL.md` in the skill's `uri` with the file's path; it serves the version injected here.",
  none: "Only each SKILL.md is provided.",
};
const SKILLS_INJECTED_LEAD =
  "These skills are pinned to this conversation, by the user or by your own earlier load. Each is a procedure for YOU: follow it whenever it applies.";
// Loading a listed skill pins it (`turnSkillLoad`): told once, ahead of the listing it applies to.
const SKILLS_LISTED_LEAD = `Loading one of these skills (reading its SKILL.md at the URI shown, with \`read_resource\` or \`read\`) pins it to the conversation: later turns show it in full here. A conversation pins at most ${MAX_PINNED_SKILLS} skills, which share one budget; a load refused for either reason says so, and the user can unpin a skill in the skills panel of the composer.`;
// Why this turn holds no `skills:*`: without it, a model reads the gap as a role
// to fix and hunts through other operations.
const SKILLS_DISCOVERY_OFF_NOTE =
  "Skill discovery is off for this conversation: that is why this turn holds no `skills:*` permission, whatever the user's role. Only the skills pinned to this conversation (shown here, if any) are available. Any listing therefore shows no skill, whatever the spaces hold — an empty result says nothing about it. The user turns discovery back on in the skills panel of the composer. Do not look for, list, load or write any other skill, and never change a role or a permission to reach one.";

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
    `You cannot browse the web, read email or call third-party APIs yourself. Your only powers are invoking Appstrate operations and calling the tools of the integrations connected in a space, found with \`search\` and called with \`call_integration_tool\`.${runs(" For work those tools cannot do, your hands are Appstrate agents: run one and read its result back.")} Never claim an external action that no tool result shows.`,
    `You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is ${invoke("invoking Appstrate operations", "looking Appstrate's own operations up and reading what it already exposes to you")}.${runs(" You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.", " Never claim to have carried out an action external to Appstrate yourself.")}`,
  )}

${invoke("", "You can look things up, you cannot act: answer the user from what you read, and never claim to have carried an operation out.\n")}
Choosing what to do:
${invoke(
  `- If the request is a pure Appstrate operation, call that operation directly with \`invoke_operation\`; the permissions listed in your context decide what you may call, so never name an act they do not carry.${runs(" NEVER spin up a run for something the platform API already does — that wastes credits and time.")}\n${
    authorsPackages
      ? "- To create a package — an agent, a skill or an integration — call its type's create operation (`createAgent`, `createSkill`, `createIntegrationPackage`), reading its schema with `describe` first. An integration that runs a local MCP server declares it in `source.server` and ships its code as package files: add the files after creating it, or create it by importing an `.afps` archive with `import_package_file`, which also imports a package of any other type. When a skill listed in your context guides authoring that type, load it before writing anything.\n"
      : "- Do not create, import or modify any package (agent, skill, integration) in this turn, not even through `invoke_operation`.\n"
  }`,
)}- Use files already supplied to your model directly. If you have only an \`appfile://\` URI for a file the user asks about, call \`read\` first. When it returns readable text or a file was sent to your model, answer directly from that content${runs("; do NOT launch a run merely to read or analyse it. Use a run only when direct reading does not provide usable content (for example, it returns only metadata or a format the model cannot read), the task needs specialised processing such as OCR or code, or the user asks for a new file deliverable")}.
${tools(
  "- If the request needs a connected integration's data or action, call it directly: find the tool with `search`, its `integration_tool` kind, in the space concerned, call it with `call_integration_tool`, and answer from its result. The one needed may be absent (one to reconnect comes back with a connect card): offer to connect it with `initiateIntegrationConnect`, which shows the user a connect card. For a temporary file read, pass `read_as_file: true` with one GET in the integration API tool's arguments. A successful read applies to this turn only. Answer from what your model received.\n" +
    inline(
      "To keep a copy, launch an inline run that fetches the source with that integration and writes it to outputs/. For an exact copy, give the run a revision-specific source or require the same strong ETag using If-Match. If the source lacks a version guarantee, changed, or no longer allows access, ask before saving another version. Use a run for Office formats and other files requiring conversion.\n",
    ),
)}${runs(
    `- If the request needs external information or context and names no source, use an available integration rather than answering from memory.
${tools(
  "- Run an agent instead when the task needs a runtime — a shell, a filesystem, code execution, files written to `outputs/`, long multi-step processing, a fan-out — or the integration tools cannot do it:",
  "- If the request needs an integration, an MCP, or any external action, run an agent:",
)}
  1. Run an existing agent when one matches the intent: \`get_me\` for the space concerned lists the agents the user can run, each with \`published\`, \`home_writable\` and \`takes_input\`. Call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` and \`name\`, and an \`input\` only when the agent declares an input schema. An agent with \`published: false\` and \`home_writable: false\` cannot be run: say so${inline(" and offer to compose an inline run instead", " and stop — there is no other way to run it")}.
${inline(
  `  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`, a \`manifest\` and a top-level \`prompt\`. In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with its \`${PLATFORM_LOG_TOOL}\` tool, do the work, then return the result with \`output\` as its mandatory last action.

When a request chains several external actions (e.g. scrape a page THEN email the result), do NOT chain one run per action: compose ONE sub-agent that declares ALL the needed integrations under \`dependencies.integrations\` and describes the whole chain in its \`prompt\` — a single \`run_and_wait\` call. Split into separate runs only when you must decide something between the steps (the user has to confirm, or the next step depends on a result you need to inspect first).

When you do fan out several sub-agents (genuinely independent pieces of work), three rules hold:
- Deliverable in a file, summary in \`output\`: tell each sub-agent to WRITE its full findings to \`outputs/<topic>.md\` (or \`.json\`) AND to return through \`output\` only a short summary naming that file. Both, always — a payload returned only through \`output\` is not a file you can chain, and a sub-agent that writes the file but never calls \`output\` fails its run.
- Fan in by reference, never by copy: give the next run the earlier runs' \`appfile://\` URIs (each \`run_and_wait\` result's \`files\`) in \`context_files\`; a result retyped into a \`prompt\` is a result you can get wrong.
- Bound the effort: every sub-agent \`prompt\` must carry an explicit ceiling (e.g. "at most 3 searches"), a stop criterion ("stop at 5 findings"), and \`output\` as the mandatory last action.

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
Read \`run_and_wait\`'s returned \`result\` field — that is the sub-agent's deliverable; answer the user from it and never fabricate it. If the run fails, read its \`error\` and report it plainly.

After a successful \`run_and_wait\`, deliver the result directly and briefly: present the \`result\` content (formatted for readability) and stop. Do not narrate what the run did, restate its progress logs, or add closing commentary — the user watched the run live on its card. One short lead-in sentence at most. A \`warnings\` item names an integration the run started without: say so in one sentence and never present the result as covering that source.

`,
    "\n",
  )}${reads(`Never quote run metrics — duration, cost, token usage — in your replies, even when a run resource you read carries them: the chat UI already displays them on the run card. Report only what the run produced (its result) or why it failed (its error).

`)}When a tool call fails with a recoverable error, correct the input and retry, up to a few attempts. Surface the failure, with its exact error, only once reasonable fixes are exhausted.

Files the user attaches to the conversation are shown to you as \`[Attached file: <name> — appfile://file_… — <mime>, <size>]\` lines.${runs(" Follow the direct-reading rule above before considering a run; when a run is justified, hand the URI over as `run_and_wait` describes.")} Never invent an \`appfile://\` URI.

${runs(`Files a run writes under \`outputs/\` render as downloadable chips in this chat. Content returned only through the \`output\` tool is plain data for YOU: it never becomes a file the user can open.${inline(` When the user asks for a file or downloadable deliverable (a report, a CSV, an image, a PDF…), have the sub-agent write it to \`outputs/\` AND return a short \`output\` payload for your own summary. Name it in kebab-case, in the user's language, with enough subject or scope to stand alone (for example, \`analyse-concurrents-restaurants-lyon.md\`). Without a named format, default to markdown; reach for another format only when the user asks.`)}

`)}Your context block below is DATA — the user's identity and role, the current date, the space the conversation was opened in, when it has one${skills(", the skills available")} and the permissions this turn holds. It lists neither the integrations they have connected nor the agents they can run${
    getMeReturns.length === 0
      ? ""
      : `: both differ per space, \`get_me\` returns ${new Intl.ListFormat("en").format(getMeReturns)} for the space it names`
  }. How to act on it:
- Use the current date to resolve relative dates.
${idVerbatimBullet}${skills(`- The skills under \`${SKILLS_HEADING}\` are guides for YOU — procedures you follow yourself, not packages you run. One shown in full, inside a \`<skill>\` tag, is already loaded: follow it. When one listed only by its id and \`skill://\` URI clearly matches the request, LOAD IT BEFORE acting: call \`read_resource\` with that URI verbatim, then follow the SKILL.md it returns. Load ONE at a time, and none when none clearly matches. Never load a skill whose content already appears in this conversation. To read a file a skill references, call \`read_resource\` with the skill's URI, replacing \`SKILL.md\` with the file's path.
`)}${skills(
    author(
      `- Skills are not run on their own. When you build or compose an agent and one of the listed skills fits the task, declare it under \`dependencies.skills\` keyed by its id, with the version shown (or \`"*"\` if none).
`,
      inline(`- When you compose an inline agent and one of the listed skills fits the task, declare it under the manifest's \`dependencies.skills\` keyed by its id, with the version shown (or \`"*"\` if none).
`),
    ),
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

/** A skill of the catalogue: an entry of `skills/list`, loaded by its `uri`. */
export interface CatalogueSkill {
  packageId: string;
  /** The `SKILL.md` frontmatter `name`. */
  name: string;
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
 * A rendered block (or section) and the skills it injected, which the turn's MCP bearer names,
 * with each pin's verdict (`skill_status`, written by the claim) and the budget left for an
 * assistant load.
 */
interface RenderedContext {
  text: string;
  injected: InjectedSkillMap;
  skillStatus: Record<string, PinnedSkillStatus>;
  skillBudgetLeft: number;
}

/** `## Skills`, or "": the skills section `formatCallerContext` appends after the identity lines. */
function formatSkillsSection(opts: {
  selection: ChatSkillSelection;
  capabilities: TurnCapabilities;
  catalogue: readonly CatalogueSkill[];
  contents: ReadonlyMap<string, SkillContent | null>;
}): RenderedContext {
  const skills = resolveChatSkills(opts.selection, opts.contents);
  const files = SKILLS_FILES[opts.capabilities.transport ? "tool" : "none"];
  // A listed skill the turn cannot load is noise. A pin is never listed: injected, it is shown in
  // full; left out (over budget, unreadable, unavailable), its notice says why.
  const pinned = new Set(opts.selection.pinnedSkills);
  const listed =
    opts.capabilities.readsSkills && opts.selection.skillDiscovery
      ? opts.catalogue.filter((skill) => !pinned.has(skill.packageId))
      : [];
  const groups: string[][] = [];
  if (!opts.selection.skillDiscovery) groups.push([SKILLS_DISCOVERY_OFF_NOTE]);
  if (listed.length) groups.push([SKILLS_LISTED_LEAD, ...listed.map(skillLine)]);
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
  return {
    text,
    injected: injectedSkills(skills),
    skillStatus: skills.statuses,
    skillBudgetLeft: skills.left,
  };
}

type CallerContextOpts = {
  locale?: string;
  now?: Date;
  capabilities: TurnCapabilities;
  rolePreview: boolean;
  /** The space the conversation was opened in, when the turn can act there. */
  origin?: { id: string; name: string };
  /** Limited to the origin space, which is then the only space the turn reaches. */
  restricted: boolean;
  /** The TURN's set (post-`turnPermissions`): the authoring toggle narrows it. */
  permissions: readonly string[];
  skills: ChatSkillSelection;
  /** The chosen skills active here, read by {@link buildCallerContextBlock}. */
  skillContents?: ReadonlyMap<string, SkillContent | null>;
  /** The catalogue of the turn's skills, listed by {@link buildCallerContextBlock} with discovery on. */
  skillCatalogue?: readonly CatalogueSkill[];
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
  // Facts only: the choice of a space for a call is the server instructions' rule.
  if (opts.origin) {
    lines.push(
      `This conversation was opened in ${opts.origin.name} (\`${opts.origin.id}\`)${
        opts.restricted
          ? " and is limited to it: no other space can be reached. The user lifts the limit in the composer."
          : "."
      }`,
    );
  }
  // The set is the union over the turn's spaces: it bounds what the turn may attempt, while
  // each call is decided by the role held in the space it names. Permissions are in the
  // vocabulary of `required_permissions` and the 403 hint, so the model joins the two.
  const preview = opts.rolePreview ? " (role preview active)" : "";
  lines.push(
    `Permissions this turn${preview} (the union over the spaces you can act in; each call is decided in the space it names, by your role there): ${
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
  return { ...skills, text: lines.join("\n") };
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
 * Deadline of a read over the caller's own MCP connection (the turn's skills, the composer's
 * commands, an agent launch's prompt), connection included: the preamble runs before the turn's
 * abort controller exists, and a client disconnect never cancels a turn, so the read carries its
 * own bound. Past it, a turn goes on with the skills read so far left out, each with its notice.
 */
export const CALLER_READ_TIMEOUT_MS = 10_000;

/** The pinned skills' contents and the catalogue of a turn. */
export interface ChatSkillsRead {
  contents: Map<string, SkillContent | null>;
  catalogue: CatalogueSkill[];
  /** Each listed skill's `SKILL.md` URI as a pin injects it. */
  uris: Map<string, string>;
}

/**
 * The skills of a turn, read over the MCP Skills extension (SEP-2640): with `drafts`, a skill
 * is the caller's draft when `skills/list` lists it among the drafts the caller
 * may read, else its published version; without, its published version. One definition per
 * skill for the catalogue, the injection and `uris` alike. With `catalogue`, every such skill of
 * `spaces` is listed by its `uri` (one entry per package, the first space's); each of `chosen` is injected as the text
 * `resources/read` serves at its entry's URI. Read with the caller's own
 * permissions, even with discovery off, whose turn holds no `skills:*`. A chosen skill
 * in neither list is left out (unavailable); one whose read failed — the connection, a
 * `skills/list` it may be missing from, its `resources/read` — or answered malformed (a
 * draft entry without `lock_version`, a `SKILL.md` served as a blob, or text
 * whose digest differs from the one its entry lists) is kept as `null` (unreadable). `uris`
 * gives each listed skill the `SKILL.md` URI its injection takes: the one an assistant load
 * must read to pin it. The connection is opened only when there is something to read.
 */
async function readChatSkills(
  openSkillsClient: (signal: AbortSignal) => Promise<ChatSkillsClient>,
  spaces: readonly string[],
  opts: SkillsReadOptions,
): Promise<ChatSkillsRead> {
  if (!opts.catalogue && opts.chosen.length === 0) {
    return { contents: new Map(), catalogue: [], uris: new Map() };
  }
  const signal = AbortSignal.timeout(CALLER_READ_TIMEOUT_MS);
  let client: ChatSkillsClient;
  try {
    client = await openSkillsClient(signal);
  } catch (err) {
    logger.warn("skills connection unavailable — the turn's skills left out", {
      err: String(err),
    });
    return {
      contents: new Map(opts.chosen.map((id) => [id, null])),
      catalogue: [],
      uris: new Map(),
    };
  }
  try {
    return await readSkillsOver(client, signal, spaces, opts);
  } finally {
    await client.close().catch(() => {});
  }
}

interface SkillsReadOptions {
  catalogue: boolean;
  /**
   * The drafts the caller reads stand for their skills: listed, injected and pinned at their
   * draft URI. Only when the turn itself reads them (see `buildCallerContextBlock`).
   */
  drafts: boolean;
  chosen: readonly string[];
}

/**
 * {@link readChatSkills} over a connection the caller owns, left open: the composer's commands
 * read the catalogue and the agents over one.
 */
export async function readSkillsOver(
  client: ChatSkillsClient,
  signal: AbortSignal,
  spaces: readonly string[],
  opts: SkillsReadOptions,
): Promise<ChatSkillsRead> {
  let listFailed = false;
  const list = (meta?: Record<string, unknown>) =>
    client.listSkills(meta ? { meta, signal } : { signal }).then(
      ({ skills }) => entriesByPackage(skills, spaces),
      (err: unknown) => {
        logger.warn("skills/list failed — its skills left out of the turn", {
          definition: meta ? "draft" : "published",
          err: String(err),
        });
        listFailed = true;
        return new Map<string, ListedSkillEntry>();
      },
    );
  const [published, drafts] = await Promise.all([
    list(),
    list({ [SKILL_DEFINITION_META_KEY]: "draft" }),
  ]);
  // The one definition the turn lists, injects and pins for each skill.
  const usedDrafts = opts.drafts ? drafts : new Map<string, ListedSkillEntry>();
  const injectedFrom = new Map([...published, ...usedDrafts]);
  const read: ChatSkillsRead = {
    contents: new Map(),
    catalogue: [],
    uris: new Map([...injectedFrom].map(([packageId, entry]) => [packageId, entry.uri])),
  };
  if (opts.catalogue) {
    // A draft stands for its package's published version: one line per skill.
    read.catalogue = [...injectedFrom.keys()].sort().map((packageId) => {
      const entry = injectedFrom.get(packageId)!;
      const served = servedAs(entry, usedDrafts.has(packageId));
      return {
        packageId,
        name: entry.frontmatter.name,
        description: entry.frontmatter.description,
        version: served?.definition === "published" ? served.version : null,
        uri: entry.uri,
      };
    });
  }
  await Promise.all(
    opts.chosen.map(async (id) => {
      const entry = injectedFrom.get(id);
      if (!entry) {
        // Missing from a listing that failed is not known to be unavailable.
        if (listFailed) read.contents.set(id, null);
        return;
      }
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
      if (!content) {
        read.contents.set(id, null);
        return;
      }
      const served = servedAs(entry, usedDrafts.has(id));
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
 * Build the caller-context system-prompt block: the identity, the space the conversation was
 * opened in (and whether it is limited to it), when there is one, and the turn's permissions. Built from the
 * already-authenticated request context, with no read of the platform: the integrations and
 * the agents differ per space, so the model looks them up with its tools. The skills are
 * those of the turn's spaces, one per package (the first in reach order), each bound in the
 * claim to the space its URI names.
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
    /**
     * The turn works on the caller's drafts: package authoring on and the caller holds
     * `skills:write`. Then every skill it lists, injects or pins is the caller's draft when there
     * is one: the turn reads a listed draft with `skills:write`, and an injected one through its
     * claim even with discovery off. Off, every one is the published version, so a load of a
     * listed URI is the definition later turns inject.
     */
    drafts: boolean;
    /** Opened only when the turn lists or injects skills, under `signal`; closed once they are read. */
    openSkillsClient: (signal: AbortSignal) => Promise<ChatSkillsClient>;
  },
): Promise<
  Omit<RenderedContext, "injected"> & { injected: InjectedSkills; skillUris: Map<string, string> }
> {
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
  const turnSkills = await readChatSkills(
    args.openSkillsClient,
    args.spaces.map((space) => space.id),
    {
      catalogue: capabilities.readsSkills && skills.skillDiscovery,
      drafts: args.drafts,
      chosen: skills.pinnedSkills,
    },
  );
  const { injected, ...rendered } = formatCallerContext(identity, {
    locale,
    capabilities,
    rolePreview: persona !== undefined,
    permissions: args.permissions,
    origin: args.origin,
    restricted: args.restricted,
    skills,
    skillContents: turnSkills.contents,
    skillCatalogue: turnSkills.catalogue,
  });
  // What `resources/read` serves without `skills:*`: each skill in the space its URI names.
  return { ...rendered, injected: { skills: injected }, skillUris: turnSkills.uris };
}
