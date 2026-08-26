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
import { logger } from "./logger.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";

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
    orgRole?: string;
    orgName?: string;
    orgSlug?: string;
    /**
     * Caller's resolved RBAC permission set (from the platform auth pipeline).
     * Forwarded into the scoped platform-MCP bearer the Pi engine
     * hands its external binary, so the meta-tools authorize with exactly the
     * caller's own permissions — no amplification.
     */
    permissions?: Set<string>;
  };
};

export const SYSTEM_PROMPT = `You are Appstrate's assistant. You help the user operate their Appstrate instance through the available tools.

**You have no ability of your own to act on the outside world.** You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is invoking Appstrate operations. You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.

Use the tools to ground every action. For ordinary Appstrate API work, search for the right operation, read its schema, then invoke it. When you need a newly launched run's progress or result in this turn, prefer calling \`run_and_wait\` directly: it owns launch plus waiting and already declares its argument schema. The \`runAgent\` and \`runInline\` operations remain available through \`describe_operation\` and \`invoke_operation\` when you intentionally need fire-and-forget semantics. Never invent an operationId or argument shape.

Choosing what to do:
- If the request is a pure Appstrate operation (list or inspect runs, schedule, manage agents, search files), call that operation directly with \`invoke_operation\`. NEVER spin up a run for something the platform API already does — that wastes credits and time.
- If the request is to summarise, analyse, or answer questions about a file available as an \`appfile://\` URI, call \`read_file\` first. When it returns readable text, answer directly from that content; do NOT launch a run merely to read or analyse it. Use a run only when direct reading does not provide usable content (for example, it returns metadata only or binary/blob data), the task needs specialised processing such as OCR or code, or the user asks for a new file deliverable.
- If the request needs external information or context and names no source, default to the integrations already available to the user — connected ones first, then ones activated for this space — rather than answering from memory or asking which source to use. Ask only when no available integration plausibly covers the need.
- If the request needs an integration, an MCP, or any external action, run an agent:
  1. Prefer an existing agent the user can run (listed in your context below) when one matches the intent — call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` (KEEP the leading \`@\`, e.g. \`@acme\`) and \`name\`. Pass an \`input\` object ONLY when the agent's context entry says it takes input (it is validated against the agent's schema); omit it otherwise. \`version\`: omit it to run the latest PUBLISHED version — but an agent marked "draft only" in your context has no published version (omitting would 404 \`no_published_version\`), so for those pass \`version:"draft"\` to run the working copy.
  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`: pass a PARTIAL canonical AFPS agent \`manifest\` plus a top-level \`prompt\`. Give EVERY inline run a task-specific identity: set \`manifest.display_name\` to a concise human title in the user's language that describes the exact action or outcome of THIS run (for example, "Analyse des 3 derniers e-mails"). The platform derives the matching \`@inline/<kebab-case-slug>\` name and fills omitted AFPS boilerplate, \`runtime_tools\` (log, output, publish_file), and an open object output schema. Defaults apply ONLY to absent top-level fields: every field you provide replaces its default exactly, arrays and nested objects are never merged, and \`runtime_tools: []\` stays empty. You can override EVERY field — including \`name\`, \`runtime_tools\`, and a complete strict \`output.schema\` — when the task needs a complex deterministic manifest; if you provide a non-empty output schema, your explicit runtime tools must include \`output\`. Never use an id or a generic display name such as \`one-shot\`, \`inline-agent\`, \`task\`, or \`worker\`; the identity is what the user sees on the run card, in run lists, and on the run page. In the manifest, declare the integration(s) under \`dependencies.integrations\` (use the exact \`@scope/name\` id and version from your context), then select that integration's tools under \`integrations_configuration.<id>.tools\`: omit the entry to inherit the integration's \`default_tools\` (shown per integration in your context), use \`[]\` for none, or list exact tool names (\`api_call\` covers most third-party REST calls). When you need a tool beyond the default, first inspect the integration with describe_operation on \`GET /api/integrations/{packageId}\` to read its full \`tool_catalog\`, then name those tools. When one of the skills listed in your context fits the task, attach it under \`dependencies.skills\` keyed by its \`@scope/name\` id with a satisfiable range (use the version shown in your context, e.g. \`"^1.2.0"\`, or \`"*"\` if none); the agent then has that skill's instructions available. In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with \`log\`, do the work, then return the result with \`output\` as its mandatory last action.

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
    "integrations_configuration": { "@appstrate/gmail": { "tools": ["api_call"] } }
  },
  "prompt": "You are a sub-agent. Log meaningful progress with the log tool. Fetch the user's 3 most recent emails, summarise them, and return the summary by calling the output tool."
}
\`\`\`
Then read \`result.summary\` from the \`run_and_wait\` result and reply to the user from it.

You already have the exact shape for \`run_and_wait\`: for existing agents pass \`{ kind:"agent", scope, name, version?, input? }\`; for inline runs pass \`{ kind:"inline", manifest, prompt, input?, context_files? }\` — those two optional arguments are the ONLY top-level way to give an inline run a file, and any other argument name is dropped before the launch. Either kind also takes \`connection_overrides\` — a top-level \`{ "<integration id>": "<connection id>" }\` map, used only to retry after a \`must_choose_connection\` error names its \`candidate_connection_ids\`. (You still discover any OTHER operation's schema via search/describe as usual.) Read \`run_and_wait\`'s returned \`result\` field — that is the sub-agent's deliverable; answer the user from it and never fabricate it. If the run fails, read its \`error\` and report it plainly.

After a successful \`run_and_wait\`, deliver the result directly and briefly: present the \`result\` content (formatted for readability) and stop. Do not narrate what the run did, restate its progress logs, or add closing commentary — the user watched the run live on its card. One short lead-in sentence at most.

Never quote run metrics — duration, cost, token usage — in your replies, even when a run resource you read carries them: the chat UI already displays them on the run card. Report only what the run produced (its result) or why it failed (its error).

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error. One failure is never fixed by retrying, but has a direct remedy: an \`integration_not_active\` error on \`integrations.<id>\` means the integration is connected but not activated for this space — do NOT re-run and do NOT restart the connect flow (connecting is personal, activating is organization-wide). Activate it instead: call \`activateIntegration\` on that package id, then re-run once. Activation is admin-only, so that call is refused (403) when the user is not an administrator — in that case say plainly that an administrator must activate that integration, and stop.

Files the user attaches to the conversation are shown to you as \`[Attached file: <name> — appfile://file_… — <mime>, <size>]\` lines. Follow the direct-reading rule above before considering a run. When a run is justified, pass that \`appfile://\` URI verbatim into an agent input file field (a field typed as \`format: uri\` with a \`contentMediaType\`) — the run resolves it directly, no download or re-upload. \`upload://\` URIs work the same way. For an INLINE run, declare nothing: list the \`appfile://\` URIs in \`run_and_wait\`'s top-level \`context_files\` and the platform mounts them read-only under \`files/\` and announces them in the run's prompt — that is the cheap path, use it. Declaring the file field yourself in the manifest's \`input.schema\` (\`{"type":"string","format":"uri","contentMediaType":"<mime>"}\`) plus a top-level \`input\` still works, and remains the ONLY way for a \`kind:"agent"\` run: a published agent's input schema is a versioned contract the platform never rewrites, so pass the URI through one of its declared file fields. \`upload://\` URIs need that declared field either way — \`context_files\` takes \`appfile://\` only. Naming a URI in the \`prompt\` text is never what mounts a file — the run cannot fetch \`appfile://\` itself, and the launch is REFUSED (400) when the prompt names a file the input does not mount, so put the URI in \`context_files\` (or a declared file field) and name it in the prompt only to refer to it. Never invent an \`appfile://\` URI.

The reverse direction — the user asks for a file or downloadable deliverable (a report, a CSV, an image, a PDF…) — needs a FILE, not text in the output payload: instruct the sub-agent, in its \`prompt\`, to WRITE the deliverable as a file into the \`outputs/\` directory of its workspace (creating it if needed). Everything under \`outputs/\` is published automatically when the run ends: the files appear on the run's page, come back in the \`run_and_wait\` result's \`files\` list, and render as downloadable chips in this chat. Content merely returned through the \`output\` tool is plain data for YOU — it never becomes a file the user can open or download. Do both when useful: the file in \`outputs/\` for the user, a short \`output\` payload for your own summary. Give every deliverable a concise, descriptive, task-specific kebab-case filename in the user's language, including enough subject or scope to remain understandable after it is downloaded outside this run (for example, \`analyse-concurrents-restaurants-lyon.md\`). NEVER use context-free names such as ${CONTEXT_FREE_FILENAMES_PHRASE}. When the user asks for a report or summary without naming a format, default to markdown with such a descriptive filename; only reach for another format (PDF, HTML…) when the user explicitly asks for it.

Your context block below is DATA — the user's identity and role, the current date, the integrations they have connected, the agents they can run, and the skills available. How to act on it:
- Use the current date to resolve relative dates and schedules.
- Use every \`@scope/name\` id verbatim: in \`dependencies.integrations\`, in \`run_and_wait\`'s \`scope\`/\`name\`, and in \`dependencies.skills\`.
- Prefer running an existing agent over doing the work inline when one fits the task. Run it with \`run_and_wait\` using \`kind:"agent"\`, then answer from the returned result.
- Skills are not run on their own. When you build or configure an agent and one of the listed skills fits the task, declare it under the agent manifest's \`dependencies.skills\` keyed by its id (e.g. \`"@appstrate/web-research": "^1.2.0"\`) — use the version shown, or \`"*"\` if none. The run route validates that declared skills exist.
- A list marked \`(list truncated)\` is partial: call \`invoke_operation\` with \`operation_id: "listAgents"\` or \`"listSkills"\` for the full one.
- The context carries NO run history. When the user asks about a recent or failed run, or wants to re-run something, without naming it, call \`listRuns\` (newest first) before answering, then fetch full details with the run get operation when needed.

Respect the user's role: actions beyond it will be refused by the platform — don't attempt them.`;

/** Shape of GET /api/me/context (the `get_me` payload). Validated loosely. */
interface CallerContext {
  user?: { name?: string | null; email?: string | null } | null;
  org?: { role?: string | null; name?: string | null; slug?: string | null } | null;
  /**
   * The caller's most recent runs (actor-scoped), newest first.
   *
   * Present on the wire but NOT rendered into the prompt — see the note in
   * `formatCallerContext`. This interface describes the `/api/me/context`
   * payload, which also backs the platform MCP `get_me` tool, so the field is
   * documented here even though this module no longer reads it.
   */
  recent_runs?:
    | {
        package_id: string;
        status: string;
        run_number?: number | null;
        started_at?: string | null;
        error?: string | null;
      }[]
    | null;
  connections?:
    | {
        integration_id: string;
        name: string;
        source: string;
        version?: string;
        default_tools?: readonly string[] | "*" | null;
      }[]
    | null;
  agents?:
    | {
        package_id: string;
        display_name?: string | null;
        description?: string | null;
        takes_input?: boolean | null;
        /** False = draft-only agent; the model must run it with `version=draft`. */
        published?: boolean | null;
      }[]
    | null;
  agents_truncated?: boolean | null;
  skills?:
    | {
        package_id: string;
        display_name?: string | null;
        description?: string | null;
        version?: string | null;
      }[]
    | null;
  skills_truncated?: boolean | null;
}

/**
 * Render an integration's AFPS §4.4 `default_tools` for the caller-context
 * line. `"*"` → all tools; a non-empty array → the names; anything else
 * (absent, empty, null) → an explicit "no default" so the model knows it
 * must select tools itself rather than relying on inheritance.
 */
function formatConnectionDefaultTools(d: readonly string[] | "*" | null | undefined): string {
  if (d === "*") return "default: all tools";
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

/**
 * Render the caller context into a system-prompt block. Returns "" when the
 * payload is unusable so the caller can skip injection.
 */
export function formatCallerContext(raw: unknown, opts?: { locale?: string; now?: Date }): string {
  const ctx = (raw ?? {}) as CallerContext;
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
    !ctx.skills?.length
  )
    return "";

  const who = name && email ? `${name} (${email})` : (name ?? email ?? "the user");
  const orgLabel = orgName
    ? ` in the organization "${orgName}"${orgSlug ? ` (\`${orgSlug}\`)` : ""}`
    : "";
  const lines = [
    "## Your context",
    `You are assisting ${who}${role ? `, whose role is "${role}"` : ""}${orgLabel}.`,
  ];
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
  const now = new Date(opts?.now ?? Date.now());
  now.setUTCMinutes(0, 0, 0);
  lines.push(`Current date and time: ${now.toISOString()} (UTC, rounded to the hour).`);
  // UI language forwarded by the client (`X-Chat-Locale`), defaulting to the
  // platform's default locale (fr) when absent.
  lines.push(
    `Reply in the user's language (${normalizeChatLocale(opts?.locale)}) unless they switch.`,
  );
  if (ctx.connections?.length) {
    // Render the exact package id (and version when known) so the model can use
    // it verbatim in an inline run's `dependencies.integrations` without a
    // discovery round-trip — the display name alone forced a lookup detour.
    const list = ctx.connections
      .map((c) => {
        const ver = c.version ? `@${c.version}` : "";
        return `${c.name} — \`${c.integration_id}\`${ver} (${c.source}; ${formatConnectionDefaultTools(c.default_tools)})`;
      })
      .join(", ");
    // Render the connected integrations as data only — the `@scope/name` id (+
    // version) the model uses verbatim. The preference order (connected >
    // activated > inactive) and the default-vs-tool_catalog selection rule live
    // once in the platform MCP server instructions (apps/api/src/modules/mcp/
    // router.ts), which the engine already receives through its own MCP
    // handshake; don't restate them here or the two drift. The "use the id
    // verbatim" instruction lives in SYSTEM_PROMPT for the same reason — see
    // the block-wide rule below.
    lines.push(`Integrations the user has connected and could attach to an agent: ${list}.`);
  } else {
    lines.push("The user has no connected integrations yet.");
  }
  if (ctx.agents?.length) {
    lines.push("", "## Existing agents you can run");
    for (const a of ctx.agents) {
      const desc = a.description?.trim();
      const label = a.display_name?.trim() || a.package_id;
      lines.push(
        `- \`${a.package_id}\` — ${label}${desc ? `: ${desc}` : ""}` +
          ` (takes input: ${a.takes_input ? "yes" : "no"}` +
          `${a.published === false ? "; draft only — run with version=draft" : ""})`,
      );
    }
    if (ctx.agents_truncated) lines.push("(list truncated)");
  }
  if (ctx.skills?.length) {
    lines.push("", "## Skills you can attach to an agent");
    for (const s of ctx.skills) {
      const desc = s.description?.trim();
      const label = s.display_name?.trim() || s.package_id;
      lines.push(
        `- \`${s.package_id}\`${s.version ? ` (v${s.version})` : ""} — ${label}` +
          (desc ? `: ${desc}` : ""),
      );
    }
    if (ctx.skills_truncated) lines.push("(list truncated)");
  }
  // `recent_runs` is DELIBERATELY not rendered. It carried `started_at` and
  // rewrote itself the moment the user launched anything — i.e. on exactly the
  // turns this product exists for — which busted the system prompt's single
  // cache breakpoint, and the conversation history behind it, on every one of
  // them. The payload field stays on `CallerContext` because the same
  // `/api/me/context` response backs the platform MCP `get_me` tool; only this
  // rendering goes. SYSTEM_PROMPT tells the model to call `listRuns` when the
  // user refers to a run without naming it — one tool call on that path, in
  // exchange for a cacheable prefix on every turn.
  return lines.join("\n");
}

/**
 * Build the caller-context system-prompt block from `GET /api/me/context` — the
 * canonical assembler the platform MCP `get_me` tool also uses, so the chat
 * prompt and the MCP surface can never drift. Dispatched IN-PROCESS through the
 * platform app (auth + RBAC re-run on the dispatched Request), with a loopback
 * `fetch` fallback inside `deps.dispatch` for OSS/test wiring.
 *
 * The endpoint is space-scoped: without a space id `requireAppContext`
 * would 400, so we skip straight to an identity-only block built from the
 * already-authenticated request context (name/email/role/org). A 400 from the
 * dispatch degrades to that same identity-only block; any other failure
 * degrades to no block (""). Identity always survives so date/role grounding
 * holds even with no space context.
 */
export async function buildCallerContextBlock(
  c: Context<ChatEnv>,
  args: {
    origin: string;
    headers: Record<string, string>;
    spaceId?: string;
    user: { id: string; name?: string | null; email?: string | null };
    deps: ChatPlatformDeps;
    /** UI language forwarded by the client (`X-Chat-Locale`); defaults to fr. */
    locale?: string;
  },
): Promise<string> {
  const { origin, headers, spaceId, user, deps, locale } = args;
  const role = c.get("orgRole");
  const orgName = c.get("orgName");
  const orgSlug = c.get("orgSlug");

  // Identity/role straight off the request context — the fallback when there is
  // no space context to fetch the space-scoped lists against.
  const identityOnly = (): string =>
    formatCallerContext(
      {
        user: { name: user.name ?? null, email: user.email ?? null },
        org: { role: role ?? null, name: orgName ?? null, slug: orgSlug ?? null },
      },
      { locale },
    );

  if (!spaceId) return identityOnly();
  try {
    const ctxHeaders = new Headers();
    for (const [k, v] of Object.entries(headers)) ctxHeaders.set(k, v);
    ctxHeaders.set("x-space-id", spaceId);
    const res = await deps.dispatch(
      new Request(new URL("/api/me/context", origin).toString(), { headers: ctxHeaders }),
    );
    if (res.ok) return formatCallerContext((await res.json()) as CallerContext, { locale });
    // No space context (e.g. requireAppContext rejected) — keep the
    // identity/role block rather than dropping context entirely.
    if (res.status === 400) return identityOnly();
    return "";
  } catch (err) {
    logger.warn("me/context unavailable — chat degrades without caller context", {
      err: String(err),
    });
    return "";
  }
}
