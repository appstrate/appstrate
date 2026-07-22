// SPDX-License-Identifier: Apache-2.0

/**
 * Chat system-prompt construction: the static tool-grounding prompt, the caller
 * context (`GET /api/me/context`) rendering, and its assembler. Split out of
 * `chat-stream.ts` so prompt authoring lives apart from stream orchestration.
 *
 * The prompt deliberately does NOT restate the cross-cutting guidance the
 * platform MCP server already sends via its `instructions` (async runs, the
 * run_and_wait shortcut, integration selection/preference, connect-before-run,
 * heavy-list projection). Both chat engines already receive that server text
 * (ai-sdk appends `mcp.instructions`; the subscription SDK gets it through its
 * own MCP handshake), so duplicating it here only lets the two drift. Keep only
 * chat-specific value: persona, the operation-vs-agent decision tree, the inline
 * manifest authoring pattern, and how to consume a run's result.
 */

import type { Context } from "hono";
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
     * Forwarded into the scoped platform-MCP bearer the subscription engine
     * hands its external binary, so the meta-tools authorize with exactly the
     * caller's own permissions — no amplification.
     */
    permissions?: Set<string>;
  };
};

/** Max length of a run error message rendered in the caller-context block. */
const RUN_ERROR_MAX_CHARS = 200;

export const SYSTEM_PROMPT = `You are Appstrate's assistant. You help the user operate their Appstrate instance through the available tools.

**You have no ability of your own to act on the outside world.** You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is invoking Appstrate operations. You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.

Use the tools to ground every action. For ordinary Appstrate API work, search for the right operation, read its schema, then invoke it. For launching or waiting on agent runs, this rule has one exception: use \`run_and_wait\` directly. Never invent an operationId or argument shape.

Choosing what to do:
- If the request is a pure Appstrate operation (list or inspect runs, schedule, manage agents, search documents), call that operation directly with \`invoke_operation\`. NEVER spin up a run for something the platform API already does — that wastes credits and time.
- If the request needs external information or context and names no source, default to the integrations already available to the user — connected ones first, then ones activated for this application — rather than answering from memory or asking which source to use. Ask only when no available integration plausibly covers the need.
- If the request needs an integration, an MCP, or any external action, run an agent:
  1. Prefer an existing agent the user can run (listed in your context below) when one matches the intent — call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` (KEEP the leading \`@\`, e.g. \`@acme\`) and \`name\`. Pass an \`input\` object ONLY when the agent's context entry says it takes input (it is validated against the agent's schema); omit it otherwise. \`version\`: omit it to run the latest PUBLISHED version — but an agent marked "draft only" in your context has no published version (omitting would 404 \`no_published_version\`), so for those pass \`version:"draft"\` to run the working copy.
  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`: pass a full AFPS agent \`manifest\` plus a \`prompt\`. In the manifest, declare the integration(s) under \`dependencies.integrations\` (use the exact \`@scope/name\` id and version from your context), then select that integration's tools under \`integrations_configuration.<id>.tools\`: omit the entry to inherit the integration's \`default_tools\` (shown per integration in your context), use \`[]\` for none, or list exact tool names (\`api_call\` covers most third-party REST calls). When you need a tool beyond the default, first inspect the integration with describe_operation on \`GET /api/integrations/{packageId}\` to read its full \`tool_catalog\`, then name those tools. When one of the skills listed in your context fits the task, attach it under \`dependencies.skills\` keyed by its \`@scope/name\` id with a satisfiable range (use the version shown in your context, e.g. \`"^1.2.0"\`, or \`"*"\` if none); the agent then has that skill's instructions available. Set \`runtime_tools: ["log", "output"]\`, and define an \`output.schema\` for the data you want back. In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with the \`log\` tool, do the work, then return the result by calling the \`output\` tool with a payload that satisfies the schema. Without that output schema and instruction you will receive nothing back.

When a request chains several external actions (e.g. scrape a page THEN email the result), do NOT chain one run per action: compose ONE sub-agent that declares ALL the needed integrations under \`dependencies.integrations\` and describes the whole chain in its \`prompt\` — a single \`run_and_wait\` call. Split into separate runs only when you must decide something between the steps (the user has to confirm, or the next step depends on a result you need to inspect first).

Example — summarising the user's latest emails (adapt the integration id, version, tools, and schema to the actual request):
\`\`\`json
{
  "manifest": {
    "$schema": "https://schemas.afps.dev/v0/agent.schema.json",
    "schema_version": "0.2",
    "name": "@inline/one-shot",
    "type": "agent",
    "version": "1.0.0",
    "timeout": 300,
    "dependencies": {
      "integrations": { "@appstrate/gmail": "^1.1.0" },
      "skills": { "@appstrate/web-research": "^1.2.0" }
    },
    "integrations_configuration": { "@appstrate/gmail": { "tools": ["api_call"] } },
    "runtime_tools": ["log", "output"],
    "output": {
      "schema": {
        "type": "object",
        "required": ["summary"],
        "properties": { "summary": { "type": "string" } }
      },
      "property_order": ["summary"]
    }
  },
  "prompt": "You are a sub-agent. Log meaningful progress with the log tool. Fetch the user's 3 most recent emails, summarise them, and return the summary by calling the output tool."
}
\`\`\`
Then read \`result.summary\` from the \`run_and_wait\` result and reply to the user from it.

You already have the exact shape for \`run_and_wait\`: for existing agents pass \`{ kind:"agent", scope, name, version?, input? }\`; for inline runs pass \`{ kind:"inline", manifest, prompt, config? }\`. (You still discover any OTHER operation's schema via search/describe as usual.) Read \`run_and_wait\`'s returned \`result\` field — that is the sub-agent's deliverable; answer the user from it and never fabricate it. If the run fails, read its \`error\` and report it plainly.

After a successful \`run_and_wait\`, deliver the result directly and briefly: present the \`result\` content (formatted for readability) and stop. Do not narrate what the run did, restate its progress logs, or add closing commentary — the user watched the run live on its card. One short lead-in sentence at most.

Never quote run metrics — duration, cost, token usage — in your replies, even when a run resource you read carries them: the chat UI already displays them on the run card. Report only what the run produced (its result) or why it failed (its error).

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.

Documents the user attaches to the conversation are shown to you as \`[Attached document: <name> — document://doc_… — <mime>, <size>]\` lines. Pass that \`document://\` URI verbatim into an agent input file field (a field typed as \`format: uri\` with a \`contentMediaType\`) when running an agent — the run resolves it directly, no download or re-upload. \`upload://\` URIs work the same way. When no existing agent fits, an inline run can process an attached document: declare the file field yourself in the manifest's \`input.schema\` (\`{"type":"string","format":"uri","contentMediaType":"<mime>"}\`) and pass the \`document://\` URI in \`run_and_wait\`'s top-level \`input\` — the platform streams the file into the run's workspace under \`documents/\`. Never invent a \`document://\` URI.

The reverse direction — the user asks for a document, file, or downloadable deliverable (a report, a CSV, an image, a PDF…) — needs a FILE, not text in the output payload: instruct the sub-agent, in its \`prompt\`, to WRITE the deliverable as a file into the \`outputs/\` directory of its workspace (creating it if needed). Everything under \`outputs/\` is published automatically when the run ends: the documents appear on the run's page, come back in the \`run_and_wait\` result's \`documents\` list, and render as downloadable chips in this chat. Content merely returned through the \`output\` tool is plain data for YOU — it never becomes a document the user can open or download. Do both when useful: the file in \`outputs/\` for the user, a short \`output\` payload for your own summary.

Respect the user's role: actions beyond it will be refused by the platform — don't attempt them.`;

/** Shape of GET /api/me/context (the `get_me` payload). Validated loosely. */
interface CallerContext {
  user?: { name?: string | null; email?: string | null } | null;
  org?: { role?: string | null; name?: string | null; slug?: string | null } | null;
  /**
   * The caller's most recent runs (actor-scoped), newest first — lets the model
   * reference the last run/failure without a discovery round-trip.
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
export function formatCallerContext(raw: unknown, opts?: { locale?: string }): string {
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
    !ctx.skills?.length &&
    !ctx.recent_runs?.length
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
  // Rounded to the minute: the system prompt is prefix-cached (anthropic
  // cache_control / OpenAI auto-prefix), and a per-request seconds+millis
  // timestamp would bust that cache on every turn for zero grounding value.
  const now = new Date();
  now.setUTCSeconds(0, 0);
  lines.push(
    `Current date and time: ${now.toISOString()} (UTC). ` +
      "Use this to resolve relative dates and schedules.",
  );
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
    // router.ts), which both chat engines already receive; don't restate them
    // here or the two drift.
    lines.push(
      `Integrations the user has connected and could attach to an agent: ${list}. Use the \`@scope/name\` id verbatim.`,
    );
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
    if (ctx.agents_truncated) {
      lines.push("More agents are available — use the search_operations tool to find them.");
    }
    lines.push(
      "Prefer running an existing agent over doing the work inline when one fits the task. " +
        'Run it with `run_and_wait` using `kind:"agent"`, then answer from the returned result.',
    );
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
    if (ctx.skills_truncated) {
      lines.push("More skills are available — use the search_operations tool to find them.");
    }
    lines.push(
      "Skills are not run on their own. When you build or configure an agent and one of these " +
        "skills fits the task, declare it under the agent manifest's `dependencies.skills` keyed by " +
        'its id (e.g. `"@appstrate/web-research": "^1.2.0"`) — use the version shown, or `"*"` ' +
        "if none. The run route validates that declared skills exist.",
    );
  }
  if (ctx.recent_runs?.length) {
    lines.push("", "## The user's recent runs (newest first)");
    for (const r of ctx.recent_runs) {
      const num = typeof r.run_number === "number" ? ` #${r.run_number}` : "";
      const when = r.started_at?.trim() ? `, ${r.started_at.trim()}` : "";
      const err = r.error?.trim()
        ? ` — error: ${truncate(r.error.trim(), RUN_ERROR_MAX_CHARS)}`
        : "";
      lines.push(`- \`${r.package_id}\`${num} — ${r.status}${when}${err}`);
    }
    lines.push(
      "Reference these when the user asks about a recent or failed run, or wants to re-run " +
        "something; fetch full details with the run get operation when needed.",
    );
  }
  return lines.join("\n");
}

/** Clamp a string for prompt size, appending an ellipsis when truncated. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Build the caller-context system-prompt block from `GET /api/me/context` — the
 * canonical assembler the platform MCP `get_me` tool also uses, so the chat
 * prompt and the MCP surface can never drift. Dispatched IN-PROCESS through the
 * platform app (auth + RBAC re-run on the dispatched Request), with a loopback
 * `fetch` fallback inside `deps.dispatch` for OSS/test wiring.
 *
 * The endpoint is app-scoped: without an application id `requireAppContext`
 * would 400, so we skip straight to an identity-only block built from the
 * already-authenticated request context (name/email/role/org). A 400 from the
 * dispatch degrades to that same identity-only block; any other failure
 * degrades to no block (""). Identity always survives so date/role grounding
 * holds even with no application context.
 */
export async function buildCallerContextBlock(
  c: Context<ChatEnv>,
  args: {
    origin: string;
    headers: Record<string, string>;
    applicationId?: string;
    user: { id: string; name?: string | null; email?: string | null };
    deps: ChatPlatformDeps;
    /** UI language forwarded by the client (`X-Chat-Locale`); defaults to fr. */
    locale?: string;
  },
): Promise<string> {
  const { origin, headers, applicationId, user, deps, locale } = args;
  const role = c.get("orgRole");
  const orgName = c.get("orgName");
  const orgSlug = c.get("orgSlug");

  // Identity/role straight off the request context — the fallback when there is
  // no application context to fetch the app-scoped lists against.
  const identityOnly = (): string =>
    formatCallerContext(
      {
        user: { name: user.name ?? null, email: user.email ?? null },
        org: { role: role ?? null, name: orgName ?? null, slug: orgSlug ?? null },
      },
      { locale },
    );

  if (!applicationId) return identityOnly();
  try {
    const ctxHeaders = new Headers();
    for (const [k, v] of Object.entries(headers)) ctxHeaders.set(k, v);
    ctxHeaders.set("x-application-id", applicationId);
    const res = await deps.dispatch(
      new Request(new URL("/api/me/context", origin).toString(), { headers: ctxHeaders }),
    );
    if (res.ok) return formatCallerContext((await res.json()) as CallerContext, { locale });
    // No application context (e.g. requireAppContext rejected) — keep the
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
