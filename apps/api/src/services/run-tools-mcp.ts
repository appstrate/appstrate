// SPDX-License-Identifier: Apache-2.0

/**
 * The run MCP server — the tools of the `@appstrate/platform` system
 * integration (`log`, `note`, `pin`, `recall_memory`, `run_history`,
 * `notify`), served
 * over stateless Streamable HTTP for ONE running run.
 *
 * One server, two mounts, one auth each (the routes own the auth, this module
 * owns nothing but the run it is handed):
 *
 *   - `POST /internal/mcp` — the sidecar, authenticated by the run token;
 *   - `POST /api/runs/{runId}/mcp` — the CLI, authenticated by the standard
 *     pipeline on a remote run the caller launched.
 *
 * Every tool writes through the state services directly, at call time: a
 * `note`, `pin` or `notify` is durable the moment the call returns, whether or
 * not the run reaches finalize.
 */

import type { Context } from "hono";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  parseMcpPost,
  serveStatelessPost,
  type AppstrateToolDefinition,
  type CallToolResult,
} from "@appstrate/mcp-transport";
import { actorFromIds } from "../lib/actor.ts";
import { listResponse } from "../lib/list-response.ts";
import { appendRunLog, getRecentRuns, RUN_HISTORY_FIELDS, setRunCheckpoint } from "./state/runs.ts";
import {
  addMemories,
  CHECKPOINT_KEY,
  MAX_MEMORY_CONTENT,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  recallMemories,
  scopeFromActor,
  upsertPinned,
  type PersistenceScope,
} from "./state/package-persistence.ts";
import { createAgentMessageNotifications } from "./state/notifications.ts";
import { isPlainObject } from "@appstrate/core/safe-json";

/** Server identity returned by `initialize`. */
const RUN_TOOLS_SERVER_INFO = { name: "appstrate-platform", version: "1.0.0" } as const;

/** The running run the tools act for, resolved and authorised by the mount. */
export interface RunToolsRun {
  runId: string;
  orgId: string;
  spaceId: string;
  /** The agent the run executes (`runAgentIdentity`), the key of its memories and slots. */
  packageId: string;
  userId: string | null;
  endUserId: string | null;
}

/**
 * A tool's `inputSchema`, derived from the Zod schema its handler parses with
 * (`additionalProperties: false`, bounds and descriptions included), without
 * the `$schema` dialect key.
 */
function inputSchemaOf(schema: z.ZodObject): AppstrateToolDefinition["descriptor"]["inputSchema"] {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete json.$schema;
  return json as AppstrateToolDefinition["descriptor"]["inputSchema"];
}

const persistenceScope = (description: string) =>
  z.enum(["actor", "shared"]).optional().describe(description);

const logArgs = z.object({
  level: z
    .enum(["info", "warn", "error"])
    .describe("info: progress and milestones, warn: non-blocking issues, error: failures"),
  message: z.string().describe("Message for the user"),
});

const noteArgs = z.object({
  content: z.string().min(1).describe(`Memory text to save (max ${MAX_MEMORY_CONTENT} characters)`),
  scope: persistenceScope(
    'Persistence scope. "actor" (default) keeps the note private to the calling actor — well-suited for personal preferences. "shared" makes the note visible to every actor of the space; use for facts universal regardless of who triggered the run.',
  ),
});

const pinArgs = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/)
    .describe(
      'Pinned slot identifier. Lowercase, digits and underscores only. "checkpoint" is the carry-over slot.',
    ),
  content: z.unknown().describe("Arbitrary JSON value stored under the pinned slot."),
  scope: persistenceScope(
    'Persistence scope. "actor" (default) gives every actor their own private copy of the slot — scheduled runs, manual triggers, and different members do not share state. "shared" makes the slot space-wide; use when the slot tracks a resource shared across actors.',
  ),
});

const recallArgs = z.object({
  q: z
    .string()
    .min(1)
    .max(MAX_MEMORY_CONTENT)
    .optional()
    .describe(
      "Case-insensitive substring to match against memory content (text or JSON). " +
        "Omit for an unfiltered most-recent-first slice.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RECALL_LIMIT_MAX)
    .optional()
    .describe(`Max memories to return (1..${RECALL_LIMIT_MAX}, default ${RECALL_LIMIT_DEFAULT}).`),
});

const runHistoryArgs = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Number of past runs to return (1..50, default 10)."),
  fields: z
    .array(z.enum(RUN_HISTORY_FIELDS))
    .meta({ uniqueItems: true })
    .optional()
    .describe("Optional subset of `{checkpoint, result}` to include per run."),
});

/** Bounds of a `notify` message: one bell row, a title line and a short body. */
const NOTIFY_TITLE_MAX = 100;
const NOTIFY_MESSAGE_MAX = 500;

const notifyArgs = z.object({
  title: z
    .string()
    .min(1)
    .max(NOTIFY_TITLE_MAX)
    .describe(`Short headline shown in bold (max ${NOTIFY_TITLE_MAX} characters)`),
  message: z
    .string()
    .min(1)
    .max(NOTIFY_MESSAGE_MAX)
    .describe(`Body text under the title (max ${NOTIFY_MESSAGE_MAX} characters)`),
});

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Arguments outside the tool's input schema are a tool error the model can correct. */
function parseArgs<T>(
  tool: string,
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; args: T } | { ok: false; result: CallToolResult } {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, result: errorResult(`${tool}: invalid arguments — ${detail}`) };
}

/**
 * Build the six tool definitions bound to `run`. The run's actor decides the
 * default persistence scope; `scope: "shared"` writes the space-wide bucket.
 */
function buildRunTools(run: RunToolsRun): AppstrateToolDefinition[] {
  const actorScope = scopeFromActor(actorFromIds(run.userId, run.endUserId));
  const scopeFor = (scope: "actor" | "shared" | undefined): PersistenceScope =>
    scope === "shared" ? { type: "shared" } : actorScope;

  const log: AppstrateToolDefinition = {
    descriptor: {
      name: "log",
      description:
        "Send a progress message to the user. Write naturally — the user reads these in real time.",
      inputSchema: inputSchemaOf(logArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("log", logArgs, raw);
      if (!parsed.ok) return parsed.result;
      const { level, message } = parsed.args;
      // `event='log'` marks rows from the agent's explicit `log` tool; the chat
      // run card shows only these.
      await appendRunLog({ orgId: run.orgId }, run.runId, "progress", "log", message, null, level);
      return textResult(`Logged [${level}]: ${message}`);
    },
  };

  const note: AppstrateToolDefinition = {
    descriptor: {
      name: "note",
      description:
        "Append a long-term archive memory — a discovery, fact, or user preference worth keeping across future runs. " +
        "Archive memories are NOT injected into the system prompt; retrieve them on demand with this integration's `recall_memory` tool. " +
        'Scope defaults to "actor" — personal observations stay private to the calling actor (scheduled runs, ' +
        "manual triggers, and different members each see only their own notes). " +
        'Pass scope="shared" for facts universal to the space — API quirks, org conventions, shared-resource structure — ' +
        "so every actor can recall them. " +
        "Use for insights worth remembering (e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
      inputSchema: inputSchemaOf(noteArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("note", noteArgs, raw);
      if (!parsed.ok) return parsed.result;
      const { content, scope } = parsed.args;
      const saved = await addMemories(
        run.packageId,
        run.spaceId,
        run.orgId,
        scopeFor(scope),
        [content],
        run.runId,
      );
      if (saved === 0) {
        return errorResult(
          "note: the archive memory limit for this scope is reached; the note was not saved.",
        );
      }
      return textResult("Note saved");
    },
  };

  const pin: AppstrateToolDefinition = {
    descriptor: {
      name: "pin",
      description:
        "Upsert a named slot pinned into the system prompt on every run. Last-write-wins per (scope, key). " +
        'Use key="checkpoint" for the carry-over checkpoint; other keys (e.g. "persona", "goals") create additional pinned blocks. ' +
        'Scope defaults to "actor" — scheduled runs, manual triggers, and different members each get their own copy. ' +
        'Pass scope="shared" when the slot tracks a resource shared across actors (synced repo, shared inbox, shared DB), ' +
        "otherwise the agent will desynchronise across triggers.",
      inputSchema: inputSchemaOf(pinArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("pin", pinArgs, raw);
      if (!parsed.ok) return parsed.result;
      const { key, content, scope } = parsed.args;
      try {
        await upsertPinned(
          run.packageId,
          run.spaceId,
          run.orgId,
          scopeFor(scope),
          key,
          content,
          run.runId,
        );
      } catch (err) {
        // `upsertPinned` refuses a malformed key or content with a readable message.
        return errorResult(`pin: ${err instanceof Error ? err.message : String(err)}`);
      }
      // `runs.checkpoint` is the per-run snapshot `run_history` reads; the
      // persistence row above keeps only the latest checkpoint per scope.
      if (key === CHECKPOINT_KEY && isPlainObject(content)) {
        await setRunCheckpoint({ orgId: run.orgId, spaceId: run.spaceId }, run.runId, content);
      }
      return textResult(`Pinned slot "${key}" updated`);
    },
  };

  const recallMemory: AppstrateToolDefinition = {
    descriptor: {
      name: "recall_memory",
      description:
        "Search the agent's archive memories — durable facts and learnings from past runs that " +
        "are NOT visible in the system prompt by default. Pass an optional `q` to filter by " +
        "case-insensitive substring; omit it to retrieve the most recent archive memories. " +
        "Use this when looking for a fact you remember saving, or before answering a question " +
        "that depends on prior-session context. Returns JSON `{ memories: [...] }`.",
      inputSchema: inputSchemaOf(recallArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("recall_memory", recallArgs, raw);
      if (!parsed.ok) return parsed.result;
      const query = parsed.args.q?.trim();
      const memories = await recallMemories(run.packageId, run.spaceId, actorScope, {
        ...(query ? { query } : {}),
        limit: parsed.args.limit ?? RECALL_LIMIT_DEFAULT,
      });
      return textResult(
        JSON.stringify({
          memories: memories.map((m) => ({
            id: m.id,
            content: m.content,
            createdAt: m.createdAt.toISOString(),
            actor_type: m.actorType,
            actor_id: m.actorId,
          })),
        }),
      );
    },
  };

  const runHistory: AppstrateToolDefinition = {
    descriptor: {
      name: "run_history",
      description:
        "Fetch metadata and optionally the carry-over checkpoint or final output of the agent's " +
        'most recent past runs (current run excluded). Returns JSON `{ object: "list", data: [...], hasMore }`. ' +
        "Use for trend analysis, auditing prior executions, or recovering from a failed run.",
      inputSchema: inputSchemaOf(runHistoryArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("run_history", runHistoryArgs, raw);
      if (!parsed.ok) return parsed.result;
      const fields = [...new Set(parsed.args.fields ?? [])];
      // Actor isolation: `getRecentRuns` reads only the runs of the run's own
      // actor (the actor-less bucket for a scheduled run).
      const recent = await getRecentRuns(
        { orgId: run.orgId, spaceId: run.spaceId },
        run.packageId,
        actorFromIds(run.userId, run.endUserId),
        {
          limit: parsed.args.limit ?? 10,
          ...(fields.length > 0 ? { fields } : {}),
          excludeRunId: run.runId,
        },
      );
      return textResult(JSON.stringify(listResponse(recent)));
    },
  };

  const notify: AppstrateToolDefinition = {
    descriptor: {
      name: "notify",
      description:
        "Send an in-app notification about this run — it appears in the notification bell and links to the run. " +
        "It reaches the people the run's completion notifies: the member or end-user who triggered the run, or the " +
        "organization's owners and admins for an unattended run. Each of them receives ONE notification per run: a " +
        "second call is refused, so send it once, for what deserves attention (a result to review, a decision to make). " +
        `Title up to ${NOTIFY_TITLE_MAX} characters, message up to ${NOTIFY_MESSAGE_MAX}.`,
      inputSchema: inputSchemaOf(notifyArgs),
    },
    handler: async (raw) => {
      const parsed = parseArgs("notify", notifyArgs, raw);
      if (!parsed.ok) return parsed.result;
      const { recipients, inserted } = await createAgentMessageNotifications(
        { orgId: run.orgId, spaceId: run.spaceId },
        run.runId,
        parsed.args,
      );
      if (recipients === 0) {
        return errorResult(
          "notify: nobody can be notified for this run (a foreground run, or no recipient); nothing was sent.",
        );
      }
      if (inserted === 0) {
        return errorResult(
          "notify: this run already sent its notification; a run notifies each recipient once.",
        );
      }
      return textResult(`Notification sent to ${inserted} recipient(s)`);
    },
  };

  return [log, note, pin, recallMemory, runHistory, notify];
}

/** Answer one MCP POST for `run`. The mount has already authenticated and authorised it. */
export async function serveRunMcp(c: Context, run: RunToolsRun): Promise<Response> {
  const raw = c.req.raw;
  const body = await c.req.arrayBuffer();
  const post = parseMcpPost(body);
  const server = createMcpServer(buildRunTools(run), RUN_TOOLS_SERVER_INFO);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !post?.requestsProgress,
    // Both mounts require platform auth (the run token, or the API pipeline's
    // bearer or SameSite session cookie), so a cross-site page cannot drive
    // them; the SDK's Host allowlist would only reject reverse-proxied hosts.
    enableDnsRebindingProtection: false,
  });
  const forwarded = new Request(raw.url, { method: raw.method, headers: raw.headers, body });
  return serveStatelessPost(server, transport, forwarded, post);
}
