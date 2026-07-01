// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat` — the conversational loop, ported from the appstrate-chat
 * satellite (routes/chat.ts) with two changes:
 *
 *   1. Identity: the satellite carried two audience-bound OAuth tokens; the
 *      module forwards the caller's own headers on loopback calls (self.ts).
 *   2. Persistence: server-authoritative. This route writes the user turn
 *      before inference and the assistant turn when the stream finalizes
 *      (see persistence.ts). Generation runs through a resumable producer
 *      (resumable.ts) that drains to completion independently of the client
 *      connection, so leaving the conversation mid-inference no longer drops
 *      messages. The client history adapter is now load-only.
 *
 * Inference goes through the llm-proxy (no key here); tool calls dispatch
 * through `/api/mcp` (auth + RBAC re-applied in-process).
 */

import type { Context } from "hono";
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from "ai";

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
  };
};
import { z } from "zod";
import { parseBody, invalidRequest } from "@appstrate/core/api-errors";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-engine-contract";
import { logger } from "./logger.ts";
import { listModels, pickModel, modelFromFamily, resolveDefaultApplicationId } from "./llm.ts";
import { openPlatformMcp, platformMcpUrl, repairStringifiedToolCall } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken } from "./loopback-auth.ts";
import { buildTranscriptPrompt } from "./transcript.ts";
import { finalizeChatStream } from "./finalize-stream.ts";
import { ensureSession, persistUserMessage, persistAssistantMessage } from "./persistence.ts";
import { registerStopController, unregisterStopController } from "./stop-registry.ts";
import { setActiveStream, clearActiveStream } from "./resumable.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";

const MAX_STEPS = 16;

// Heading that fences the generated operation index at the tail of the platform
// MCP server instructions (emitted by apps/api/src/modules/mcp/router.ts). We
// split on this shared literal to drop the index — several KB re-sent on every
// step — for providers without a prompt cache (Mistral), where it would be
// re-sent uncached every step. Cached providers (Claude SDK, Anthropic via
// cache_control, OpenAI auto-prefix) keep it.

/**
 * Strip the trailing operation index from the system prompt for providers
 * without a prompt cache, where the multi-KB index would be re-sent uncached on
 * every step: Mistral. Everyone else keeps it. Tools are unaffected — the agent
 * always has search_operations for discovery when the index is absent.
 */
export function applyOperationIndexPolicy(system: string, apiShape: string): string {
  const drop = apiShape === "mistral-conversations";
  if (drop && system.includes(OPERATION_INDEX_HEADING)) {
    return system.slice(0, system.indexOf(OPERATION_INDEX_HEADING)).trimEnd();
  }
  return system;
}

/**
 * TTL for the engine path's loopback bearer. The Agent SDK bakes it into the
 * spawned binary's env once, so it must outlive the whole turn (up to
 * MAX_STEPS turns, each able to long-poll a run's status for ~55 s). 30 min
 * is a generous ceiling for a single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

/** Max length of a run error message rendered in the caller-context block. */
const RUN_ERROR_MAX_CHARS = 200;

const SYSTEM_PROMPT = `You are Appstrate's assistant. You help the user operate their Appstrate instance through the available tools.

**You have no ability of your own to act on the outside world.** You cannot browse the web, read email, call third-party APIs, or use any integration or MCP directly. Your only power is invoking Appstrate operations. You are the brain/orchestrator; your hands are Appstrate agents. Any request that needs an integration, an MCP, or any action external to Appstrate MUST be carried out by running an agent and reading its result back — never by you claiming to have done it yourself.

Use the tools to ground every action. For ordinary Appstrate API work, search for the right operation, read its schema, then invoke it. For launching or waiting on agent runs, this rule has one exception: use \`run_and_wait\` directly. Never invent an operationId or argument shape.

Choosing what to do:
- If the request is a pure Appstrate operation (list or inspect runs, schedule, manage agents, search documents), call that operation directly with \`invoke_operation\`. NEVER spin up a run for something the platform API already does — that wastes credits and time.
- If the request needs an integration, an MCP, or any external action, run an agent:
  1. Prefer an existing agent the user can run (listed in your context below) when one matches the intent — call \`run_and_wait\` with \`kind:"agent"\`, \`scope\` (KEEP the leading \`@\`, e.g. \`@acme\`) and \`name\`. Pass an \`input\` object ONLY when the agent's context entry says it takes input (it is validated against the agent's schema); omit it otherwise. \`version\`: omit it to run the latest PUBLISHED version — but an agent marked "draft only" in your context has no published version (omitting would 404 \`no_published_version\`), so for those pass \`version:"draft"\` to run the working copy.
  2. Otherwise call \`run_and_wait\` with \`kind:"inline"\`: pass a full AFPS agent \`manifest\` plus a \`prompt\`. In the manifest, declare the integration(s) under \`dependencies.integrations\` (use the exact \`@scope/name\` id and version from your context), then select that integration's tools under \`integrations_configuration.<id>.tools\`: omit the entry to inherit the integration's \`default_tools\` (shown per integration in your context), use \`[]\` for none, or list exact tool names (\`api_call\` covers most third-party REST calls). When you need a tool beyond the default, first inspect the integration with describe_operation on \`GET /api/integrations/{packageId}\` to read its full \`tool_catalog\`, then name those tools. When one of the skills listed in your context fits the task, attach it under \`dependencies.skills\` keyed by its \`@scope/name\` id with a satisfiable range (use the version shown in your context, e.g. \`"^1.2.0"\`, or \`"*"\` if none); the agent then has that skill's instructions available. Set \`runtime_tools: ["log", "output"]\`, and define an \`output.schema\` for the data you want back. In the \`prompt\`, tell the agent it is a sub-agent: report meaningful progress with the \`log\` tool, do the work, then return the result by calling the \`output\` tool with a payload that satisfies the schema. Without that output schema and instruction you will receive nothing back.

\`run_and_wait\` is the only tool you should use to launch agent runs from chat. Do NOT call \`invoke_operation\` with \`runAgent\` or \`runInline\`, do NOT call \`describe_operation\` just to learn those schemas, and do NOT call \`getRun\` just to wait for a run that \`run_and_wait\` launched.

Do NOT pre-validate a manifest with the \`validateInlineRun\` operation (\`POST /api/runs/inline/validate\`) before firing it. \`run_and_wait\` with \`kind:"inline"\` already goes through the same preflight and returns a \`400\` (without consuming credits) if the manifest is invalid — so a validate-then-run pair just runs the preflight twice, adds a round-trip, and counts against the same rate-limit bucket. Go straight to \`run_and_wait\` and handle the \`400\` if it comes. \`validateInlineRun\` is only for iterating on a manifest without firing it, which is not what a chat "do it now" request asks for.

Runs are asynchronous, but \`run_and_wait\` handles both launch and waiting for you. Use \`run_and_wait\` for agent/inline runs, then read its returned \`result\` field — that is the sub-agent's deliverable. Do NOT call run-get/\`getRun\` after \`run_and_wait\` just to wait for completion. Answer the user from \`result\`; never fabricate it. If the run fails, read its error and report it plainly.

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

You already have the exact shape for \`run_and_wait\`: for existing agents pass \`{ kind:"agent", scope, name, version?, input? }\`; for inline runs pass \`{ kind:"inline", manifest, prompt, config? }\`. Do NOT call \`describe_operation\` for run launching, and do NOT call run-get/\`getRun\` after \`run_and_wait\` just to wait. (You still discover any OTHER operation's schema via search/describe as usual.)

When a tool call fails with a recoverable error (e.g. a validation error naming a missing or malformed field, or a wrong-endpoint 404), do not stop and report it. Read the error detail, correct the input — re-read the operation schema if needed — and retry, up to a few attempts. Only surface the failure to the user once you have genuinely exhausted reasonable fixes; then show the exact error.

Respect the user's role: actions beyond it will be refused by the platform — don't attempt them. When building or configuring an agent, prefer integrations the user already has connected (listed in their context below) over asking them to connect new ones.`;

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
 * Render the caller context into a system-prompt block. Returns "" when the
 * payload is unusable so the caller can skip injection.
 */
export function formatCallerContext(raw: unknown): string {
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
  lines.push(
    `Current date and time: ${new Date().toISOString()} (UTC). ` +
      "Use this to resolve relative dates and schedules.",
  );
  // Default to French (the platform's default locale) — the UI language is not
  // forwarded to this route.
  lines.push("Reply in the user's language (fr) unless they switch.");
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

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. `messages` are UIMessages; we keep validation
// loose here and let `convertToModelMessages` enforce the real shape.
const chatStreamSchema = z.object({
  id: z.string().optional(),
  messages: z.array(z.unknown()).min(1, "messages must not be empty"),
  modelId: z.string().optional(),
});

/** Truncated JSON preview for debug logs (keeps lines readable). */
function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * Message surfaced to the user when a turn fails (the AI SDK masks errors by
 * default). We pass the provider's own error through — typically the real
 * cause (e.g. a provider key misconfigured in the org's models).
 */
function clientErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = msg.trim();
  if (!trimmed)
    return "Le modèle a échoué (erreur inconnue). Vérifiez la configuration des modèles de l'organisation.";
  return `Le modèle a échoué : ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`;
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
  },
): Promise<string> {
  const { origin, headers, applicationId, user, deps } = args;
  const role = c.get("orgRole");
  const orgName = c.get("orgName");
  const orgSlug = c.get("orgSlug");

  // Identity/role straight off the request context — the fallback when there is
  // no application context to fetch the app-scoped lists against.
  const identityOnly = (): string =>
    formatCallerContext({
      user: { name: user.name ?? null, email: user.email ?? null },
      org: { role: role ?? null, name: orgName ?? null, slug: orgSlug ?? null },
    });

  if (!applicationId) return identityOnly();
  try {
    const ctxHeaders = new Headers();
    for (const [k, v] of Object.entries(headers)) ctxHeaders.set(k, v);
    ctxHeaders.set("x-application-id", applicationId);
    const res = await deps.dispatch(
      new Request(new URL("/api/me/context", origin).toString(), { headers: ctxHeaders }),
    );
    if (res.ok) return formatCallerContext((await res.json()) as CallerContext);
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

export async function handleChatStream(
  c: Context<ChatEnv>,
  deps: ChatPlatformDeps,
): Promise<Response> {
  const orgId = c.get("orgId");
  const user = c.get("user");
  const orgRole = c.get("orgRole") ?? "member";
  const body = parseBody(chatStreamSchema, await c.req.json().catch(() => null));
  const messages = body.messages as UIMessage[];
  logger.info("chat turn", { turns: messages.length });

  const sessionId = body.id;
  const lastMessage = messages[messages.length - 1] as UIMessage | undefined;

  // Persist the session ROW up front, BEFORE the (potentially multi-second)
  // inference preamble (model resolve + MCP boot). The client mints the id and
  // creates conversations lazily, so the sidebar shows a new conversation
  // optimistically on send; without an early `ensureSession` the row would not
  // exist until after the preamble, and the sidebar's reconciling poll could
  // fire first and clobber the optimistic entry (flicker). Creating the row here
  // closes that window. Ownership is enforced inside `ensureSession` (404 on a
  // foreign-tenant id collision). The user MESSAGE and the `active_stream_id`
  // marker are still written later, just before generation — keeping the
  // "generating" flag off until we're committed to a turn, so a preamble error
  // can't strand the session as perpetually generating.
  if (sessionId && lastMessage?.id) {
    await ensureSession(sessionId, orgId, user.id);
  }

  const origin = selfOrigin();
  const headers = forwardedHeaders(c);
  // Single platform-call seam: re-enter the platform app in-process (or loopback
  // fetch when not wired) for every read the turn makes (/api/models,
  // /api/applications, /api/me/context, the llm-proxy). Auth + RBAC run each hop.
  const platformFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    deps.dispatch(new Request(input, init))) as typeof fetch;

  // Per-turn observability: structured per-step logs to stdout. Full payloads
  // only under CHAT_DEBUG — they may carry PII/customer content.
  const debug = Boolean(process.env.CHAT_DEBUG);
  const turnStart = Date.now();
  let step = 0;
  let stepStart = turnStart;
  let firstChunkAt = 0;

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own credentials (full RBAC fidelity on tool calls).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // up to MAX_STEPS steps (with a run long-poll blocking for ~55s between
  // them), so we hand modelFromFamily a *minter* — the provider re-mints a fresh
  // bearer on every proxy call. The static header below is for the one-shot
  // calls (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // ── Preamble phase A (parallel) ──────────────────────────────────────────
  // The model list and the default application id are independent reads, so
  // fire them together rather than back-to-back. `listModels` decides the
  // engine (we read the chosen row's providerId); the app id scopes the MCP
  // + integration reads that follow. Pin from the header when the caller
  // already supplied one (no lookup needed).
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const pinnedAppId = c.req.header("x-application-id");
  const phaseAStart = Date.now();
  const [models, applicationId] = await Promise.all([
    // metadata_only (skip credential decrypt) is safe only when an explicit
    // model is pinned — that id came from the filtered picker, so it's reachable.
    // Without a pin we resolve the org default from the full filtered list, so a
    // dead-credential default is dropped rather than picked → inference error.
    listModels(origin, inferenceHeaders, platformFetch, { metadataOnly: Boolean(modelId) }),
    pinnedAppId
      ? Promise.resolve(pinnedAppId)
      : resolveDefaultApplicationId(origin, headers, orgId, platformFetch),
  ]);
  const chosen = pickModel(models, modelId);
  const phaseAMs = Date.now() - phaseAStart;
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });

  // Subscription chat engine — the chat driver is contributed by the provider
  // module (only `@appstrate/module-claude-code` today) through the platform
  // contract (`ctx.services.registerChatHandler`), surfaced here through
  // `deps.chatEngine`. The chat dispatches by provider id WITHOUT importing the
  // provider module or any vendor SDK. With no provider module loaded
  // the lookup is undefined and every provider falls through to the generic
  // ai-sdk path below. Codex is agent-only (filtered from the chat model list by
  // CHAT_USABLE_FAMILIES) and registers no chat engine, so today only the Claude
  // Agent SDK reaches this branch.
  const chatEngine = deps.chatEngine(chosen.providerId ?? "");
  const isSubscription = Boolean(chatEngine);

  // Platform MCP wiring shared by both engines: the meta-tools live at
  // /api/mcp/o/:org and run with the caller's own credentials (RBAC fidelity).
  const mcpHeaders: Record<string, string> = { ...headers };
  if (applicationId) mcpHeaders["x-application-id"] = applicationId;

  // ── Preamble phase B (parallel) ──────────────────────────────────────────
  // The caller-context block (both paths) and the platform MCP probe (ai-sdk
  // path only) are independent — run them together.
  //
  // The subscription (claude-code) path SKIPS the probe entirely: the official
  // binary opens its OWN MCP connection from `platformMcp.url`, and the MCP
  // server's instructions reach the model through that handshake. A probe here
  // would be a second handshake we'd immediately close (2 round-trips wasted on
  // the TTFT path). We pass `platformMcp` optimistically; if the `mcp` module is
  // absent the SDK just gets no tools.
  let mcp: Awaited<ReturnType<typeof openPlatformMcp>> | null = null;
  // Single MCP-teardown path. The session must be closed on EVERY ai-sdk exit
  // (stream `onError` AND `onFinish`, and a mid-stream client disconnect) or it
  // leaks per turn — close failures are swallowed (warn only) so they never mask
  // the turn result. `await` it on the synchronous paths, `void` in callbacks.
  const closeMcp = async (): Promise<void> => {
    try {
      await mcp?.close();
    } catch (err) {
      logger.warn("mcp close failed", { err: String(err) });
    }
  };

  const phaseBStart = Date.now();
  const contextPromise = buildCallerContextBlock(c, {
    origin,
    headers,
    applicationId,
    user,
    deps,
  });
  let contextBlock: string;
  if (isSubscription) {
    contextBlock = await contextPromise;
  } else {
    // The chat's tools come from the platform MCP module (`/api/mcp/o/:org`).
    // `mcp` is a hard peer requirement (declared in the chat manifest, enforced
    // at boot), so a failure to open it here is a genuine misconfiguration —
    // let it propagate to a 5xx rather than silently degrading to a no-tools
    // chat.
    const [openedMcp, block] = await Promise.all([
      openPlatformMcp({ origin, headers, orgId, applicationId, fetch: platformFetch }),
      contextPromise,
    ]);
    mcp = openedMcp;
    contextBlock = block;
  }
  const phaseBMs = Date.now() - phaseBStart;

  // Assemble the system prompt. Subscription path: tool-grounding prompt, no
  // inline instructions (the SDK's own MCP handshake delivers them). ai-sdk
  // path: prompt + the platform MCP server instructions (mcp is required, so
  // it's always present here).
  let system = isSubscription
    ? SYSTEM_PROMPT
    : mcp?.instructions
      ? `${SYSTEM_PROMPT}\n\n${mcp.instructions}`
      : SYSTEM_PROMPT;
  if (contextBlock) system += `\n\n${contextBlock}`;
  system = applyOperationIndexPolicy(system, chosen.apiShape);

  logger.info("chat preamble", {
    engine: isSubscription ? "subscription" : "ai-sdk",
    providerId: chosen.providerId,
    phaseAMs,
    phaseBMs,
    preambleMs: Date.now() - turnStart,
    hasTools: isSubscription || Boolean(mcp),
  });

  // ── Server-authoritative persistence + resumable streaming ───────────────
  // Persist the user turn BEFORE inference; the assistant turn is persisted when
  // the stream finalizes (in `finalize` below). Generation runs through a
  // resumable producer that drains to completion independently of the client, so
  // leaving the conversation mid-inference can no longer drop messages.
  // Per-turn resumable stream id. It is the key for both the resumable producer
  // (live reconnect) and the stop registry, and is stored on the session as
  // `active_stream_id` so a reloaded client's resume GET can find the live turn.
  const streamId = crypto.randomUUID();

  // The session row was already ensured up front (before the preamble). Persist
  // the user turn and mark the in-flight stream now, just before generation.
  let userMessageId: string | undefined;
  if (sessionId && lastMessage?.id) {
    userMessageId = await persistUserMessage(sessionId, lastMessage);
    // Mark the in-flight stream so a mid-inference reload can reconnect to it.
    await setActiveStream(sessionId, streamId);
  }

  // Generation abort is DECOUPLED from the request connection: a client
  // disconnect must NOT cancel generation (that was the data-loss bug). Only an
  // explicit stop (POST /api/chat/sessions/:id/stop) aborts this controller.
  const generation = new AbortController();
  registerStopController(streamId, generation);

  // Tee the engine stream into a resumable producer (decoupled from the client)
  // and persist the assistant turn when it finalizes — both run to completion
  // regardless of the client; the persist task is tracked for graceful shutdown.
  // See finalize-stream.ts for the disconnect-survival guarantee + its test.
  const finalize = (engineResponse: Response): Promise<Response> =>
    finalizeChatStream({
      engineResponse,
      streamId,
      onAssistant:
        sessionId && userMessageId
          ? (assistant) => persistAssistantMessage(sessionId, assistant, userMessageId)
          : undefined,
      onSettled: () => {
        unregisterStopController(streamId);
        // Fire-and-forget teardown — swallow rejections so a failed DB update or
        // MCP close can't surface as an unhandled rejection.
        if (sessionId) void clearActiveStream(sessionId).catch(() => {});
        void closeMcp();
      },
    });

  // Teardown for the failure paths below: if generation throws BEFORE `finalize`
  // takes over (which owns teardown via `onSettled`), we must still release the
  // stop controller, clear the in-flight marker (else the session is stuck
  // "generating" with a dead stream id), and close MCP.
  const failCleanup = async () => {
    unregisterStopController(streamId);
    if (sessionId) await clearActiveStream(sessionId).catch(() => {});
    await closeMcp();
  };

  // The credential-injection gateway swaps the placeholder bearer server-side;
  // the real subscription token never enters this process or the spawned
  // binary's env. The gateway slug derives from the provider id — no vendor
  // literal. `platformMcp` is passed unconditionally (see phase B note).
  if (chatEngine) {
    const loopbackToken = mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      { ttlMs: ENGINE_LOOPBACK_TTL_MS },
    );
    try {
      return await finalize(
        chatEngine.handler({
          prompt: buildTranscriptPrompt(messages),
          system,
          modelId: chosen.modelId,
          gatewayBaseUrl: `${origin}/api/llm-proxy/${chatEngine.providerId}-sdk/${encodeURIComponent(chosen.id)}`,
          placeholderToken: loopbackToken,
          platformMcp: { url: platformMcpUrl(origin, orgId), headers: mcpHeaders },
          // Decoupled from the request connection (see `generation` above).
          abortSignal: generation.signal,
          onError: clientErrorMessage,
        }),
      );
    } catch (err) {
      await failCleanup();
      throw err;
    }
  }

  // ai-sdk path — API-key providers only, bound to the llm-proxy.
  const model = modelFromFamily(chosen, origin, inferenceHeaders, mintInferenceAuth, platformFetch);
  if (!model) {
    await failCleanup();
    throw invalidRequest(`Model family "${chosen.apiShape}" is not supported by the chat.`);
  }

  try {
    const result = streamText({
      model,
      // System rides as a cached message part rather than the `system` field:
      // the platform MCP instructions now carry a generated operation index
      // (several KB, re-sent on every one of the up-to-MAX_STEPS inference
      // calls in a turn). OpenAI auto-caches the prefix and the Claude Agent
      // SDK path caches on its own; the ai-sdk Anthropic providers need an
      // explicit cache_control breakpoint or they'd pay the index in full each
      // step. Harmless for non-Anthropic models (providerOptions is namespaced).
      messages: [
        {
          role: "system",
          content: system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        ...(await convertToModelMessages(messages)),
      ],
      tools: mcp ? mcp.tools : undefined,
      stopWhen: stepCountIs(MAX_STEPS),
      experimental_repairToolCall: repairStringifiedToolCall,
      // Decoupled from the request connection (see `generation` above): a client
      // disconnect must not cancel generation; only an explicit stop does.
      abortSignal: generation.signal,
      onChunk: ({ chunk }) => {
        // TTFT marker: log once on the first model output (text or tool call),
        // measured from turn start. The dominant lever this work optimizes.
        if (firstChunkAt === 0 && (chunk.type === "text-delta" || chunk.type === "tool-call")) {
          firstChunkAt = Date.now();
          logger.info("chat first token", { firstTokenMs: firstChunkAt - turnStart });
        }
      },
      onStepFinish: ({ toolCalls, toolResults, finishReason, usage }) => {
        const now = Date.now();
        logger.info("chat step", {
          step: step++,
          finishReason,
          usage: usage as unknown as Record<string, unknown>,
          stepMs: now - stepStart,
          tools: toolCalls.map((t) => t.toolName),
          ...(debug
            ? {
                toolCalls: toolCalls.map((t) => ({ tool: t.toolName, input: preview(t.input) })),
                toolResults: toolResults.map((t) => ({
                  tool: t.toolName,
                  output: preview(t.output),
                })),
              }
            : {}),
        });
        stepStart = now;
      },
      onError: ({ error }) => {
        // MCP teardown is owned by `finalize` (its persist `finally`), which runs
        // to completion regardless of the client — so it is not closed here.
        logger.error("chat stream error", { err: String(error) });
      },
      onFinish: ({ totalUsage, finishReason }) => {
        logger.info("chat turn done", {
          steps: step,
          totalMs: Date.now() - turnStart,
          usage: totalUsage as unknown as Record<string, unknown>,
          finishReason,
        });
      },
    });

    // NOTE: no client-disconnect → closeMcp listener. Generation now outlives the
    // connection (resumable producer), so MCP must stay open until the stream
    // finalizes; `finalize` closes it once persistence completes.
    // Surface the real failure to the client (AI SDK masks errors otherwise).
    return await finalize(
      result.toUIMessageStreamResponse({
        onError: clientErrorMessage,
        // Emit a real assistant message id in the stream so the client and the
        // server-side persist agree on it (and never collide on an empty id).
        generateMessageId: () => crypto.randomUUID(),
      }),
    );
  } catch (err) {
    await failCleanup();
    throw err;
  }
}
