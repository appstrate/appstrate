// SPDX-License-Identifier: Apache-2.0

/**
 * The run MCP server — the tools of the `@appstrate/platform` system
 * integration, served over stateless Streamable HTTP for ONE running run.
 *
 * One server, two mounts, one auth each (the routes own the auth, this module
 * owns nothing but the run it is handed):
 *
 *   - `POST /internal/mcp` — the sidecar of a platform run, authenticated by
 *     the run token;
 *   - `POST /api/runs/{id}/mcp` — the host executing a remote run,
 *     authenticated by the run's sink signature, like the run's other
 *     callback routes.
 *
 * Every tool writes through the state services directly, at call time: a
 * `note`, `pin` or `notify` is durable the moment the call returns, whether or
 * not the run reaches finalize.
 */

import type { Context } from "hono";
import { z } from "zod";
import {
  createMcpServer,
  parseMcpPost,
  serveAuthenticatedStatelessPost,
  type AppstrateToolDefinition,
  type CallToolResult,
} from "@appstrate/mcp-transport";
import { listResponse } from "@appstrate/core/list-query";
import {
  isRuntimeBoundIntegration,
  type IntegrationToolCatalogEntry,
} from "@appstrate/core/integration";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { actorFromIds } from "../lib/actor.ts";
import {
  appendRunLog,
  getRecentRuns,
  RUN_HISTORY_FIELDS,
  RUN_HISTORY_LIMIT_DEFAULT,
  RUN_HISTORY_LIMIT_MAX,
  setRunCheckpoint,
} from "./state/runs.ts";
import {
  addMemory,
  CHECKPOINT_KEY,
  MAX_MEMORY_CONTENT,
  MAX_PINNED_KEY_LENGTH,
  PINNED_KEY_PATTERN,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  recallMemories,
  scopeFromActor,
  upsertPinned,
  type PersistenceScope,
} from "./state/package-persistence.ts";
import { createAgentMessageNotifications } from "./state/notifications.ts";
import { resolveRunRecipients } from "./state/run-reads.ts";
import { isPlainObject } from "@appstrate/core/safe-json";
import { getErrorMessage } from "@appstrate/core/errors";
import type { RunSinkContext } from "../types/run-sink.ts";

/** Server identity returned by `initialize`. */
const RUN_TOOLS_SERVER_INFO = { name: "appstrate-platform", version: "1.0.0" } as const;

/** The running run the tools act for, resolved and authorised by the mount. */
type RunToolsRun = Pick<
  RunSinkContext,
  "id" | "orgId" | "spaceId" | "packageId" | "userId" | "endUserId"
>;

interface ToolContext {
  run: RunToolsRun;
  /** The run actor's bucket, the default persistence scope. */
  actorScope: PersistenceScope;
  scopeFor: (scope: "actor" | "shared" | undefined) => PersistenceScope;
}

type RunTool = ((ctx: ToolContext) => AppstrateToolDefinition) & {
  descriptor: AppstrateToolDefinition["descriptor"];
};

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * One tool: its descriptor (the `inputSchema` derived from `args`, without the
 * `$schema` key) and a handler that parses the arguments, then runs `run`.
 * Invalid arguments and an `ApiError` 400 are tool errors the model can
 * correct; anything else thrown (a database failure, a foreign-key violation
 * when the agent was deleted mid-run) is logged and reaches the model as a
 * generic error, never with the driver's message.
 */
function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  /** The display name a person reads (MCP `title`); the run journal names the call by it. */
  title: string;
  description: string;
  args: S;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<CallToolResult>;
}): RunTool {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.args);
  const descriptor = {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: inputSchema as AppstrateToolDefinition["descriptor"]["inputSchema"],
  };
  const bind = (ctx: ToolContext): AppstrateToolDefinition => ({
    descriptor,
    handler: async (raw) => {
      const parsed = spec.args.safeParse(raw ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`)
          .join("; ");
        return errorResult(`${spec.name}: invalid arguments — ${detail}`);
      }
      try {
        return await spec.run(parsed.data, ctx);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          return errorResult(`${spec.name}: ${err.message}`);
        }
        logger.error("run MCP tool failed", {
          runId: ctx.run.id,
          tool: spec.name,
          error: getErrorMessage(err),
        });
        return errorResult(`${spec.name}: the platform could not complete this call`);
      }
    },
  });
  return Object.assign(bind, { descriptor });
}

const scopeArg = (description: string) =>
  z.enum(["actor", "shared"]).optional().describe(description);

/**
 * Bound of a `log` message, in characters; a longer one is refused. The live
 * frame of a run log carries 2 000 bytes of it (`notify_run_log_insert`,
 * `@appstrate/db/notify`), so a multi-byte message near the bound is shown cut
 * while the run is watched, and stored in full.
 */
const LOG_MESSAGE_MAX = 2000;

/** Bounds of a `notify` message: one bell row, a title line and a short body. */
const NOTIFY_TITLE_MAX = 100;
const NOTIFY_MESSAGE_MAX = 500;

const RUN_TOOLS: RunTool[] = [
  defineTool({
    name: "log",
    title: "Log progress",
    description:
      "Send a progress message to the user. Write naturally — the user reads these in real time.",
    args: z.object({
      level: z
        .enum(["info", "warn", "error"])
        .describe("info: progress and milestones, warn: non-blocking issues, error: failures"),
      message: z
        .string()
        .max(LOG_MESSAGE_MAX)
        .describe(`Message for the user (max ${LOG_MESSAGE_MAX} characters)`),
    }),
    run: async ({ level, message }, { run }) => {
      // `event='log'` marks rows from the agent's explicit `log` tool; the chat
      // run card shows only these.
      await appendRunLog({ orgId: run.orgId }, run.id, "progress", "log", message, null, level);
      return textResult(`Logged [${level}]: ${message}`);
    },
  }),
  defineTool({
    name: "note",
    title: "Save a memory",
    description:
      "Append a long-term archive memory — a discovery, fact, or user preference worth keeping across future runs. " +
      "Archive memories are NOT injected into the system prompt; retrieve them on demand with this integration's `recall_memory` tool. " +
      'Scope defaults to "actor" — personal observations stay private to the calling actor (scheduled runs, ' +
      "manual triggers, and different members each see only their own notes). " +
      'Pass scope="shared" for facts universal to the space — API quirks, org conventions, shared-resource structure — ' +
      "so every actor can recall them. " +
      "Use for insights worth remembering (e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
    args: z.object({
      content: z
        .string()
        .min(1)
        .max(MAX_MEMORY_CONTENT)
        .describe(`Memory text to save (max ${MAX_MEMORY_CONTENT} characters)`),
      scope: scopeArg(
        'Persistence scope. "actor" (default) keeps the note private to the calling actor — well-suited for personal preferences. "shared" makes the note visible to every actor of the space; use for facts universal regardless of who triggered the run.',
      ),
    }),
    run: async ({ content, scope }, { run, scopeFor }) => {
      const saved = await addMemory(
        run.packageId,
        run.spaceId,
        run.orgId,
        scopeFor(scope),
        content,
        run.id,
      );
      if (!saved) {
        return errorResult(
          "note: the archive memory limit for this scope is reached; the note was not saved.",
        );
      }
      return textResult("Note saved");
    },
  }),
  defineTool({
    name: "pin",
    title: "Pin a slot",
    description:
      "Upsert a named slot pinned into the system prompt on every run. Last-write-wins per (scope, key). " +
      'Use key="checkpoint" for the carry-over checkpoint; other keys (e.g. "persona", "goals") create additional pinned blocks. ' +
      'Scope defaults to "actor" — scheduled runs, manual triggers, and different members each get their own copy. ' +
      'Pass scope="shared" when the slot tracks a resource shared across actors (synced repo, shared inbox, shared DB), ' +
      "otherwise the agent will desynchronise across triggers.",
    args: z.object({
      key: z
        .string()
        .min(1)
        .max(MAX_PINNED_KEY_LENGTH)
        .regex(PINNED_KEY_PATTERN)
        .describe(
          'Pinned slot identifier. Lowercase, digits and underscores only. "checkpoint" is the carry-over slot.',
        ),
      content: z.unknown().describe("Arbitrary JSON value stored under the pinned slot."),
      scope: scopeArg(
        'Persistence scope. "actor" (default) gives every actor their own private copy of the slot — scheduled runs, manual triggers, and different members do not share state. "shared" makes the slot space-wide; use when the slot tracks a resource shared across actors.',
      ),
    }),
    run: async ({ key, content, scope }, { run, scopeFor }) => {
      await upsertPinned(
        run.packageId,
        run.spaceId,
        run.orgId,
        scopeFor(scope),
        key,
        content,
        run.id,
      );
      // `runs.checkpoint` is the per-run snapshot `run_history` reads; the
      // persistence row above keeps only the latest checkpoint per scope.
      if (key === CHECKPOINT_KEY && isPlainObject(content)) {
        await setRunCheckpoint({ orgId: run.orgId, spaceId: run.spaceId }, run.id, content);
      }
      return textResult(`Pinned slot "${key}" updated`);
    },
  }),
  defineTool({
    name: "recall_memory",
    title: "Recall memories",
    description:
      "Search the agent's archive memories — durable facts and learnings from past runs that " +
      "are NOT visible in the system prompt by default. Pass an optional `q` to filter by " +
      "case-insensitive substring; omit it to retrieve the most recent archive memories. " +
      "Use this when looking for a fact you remember saving, or before answering a question " +
      "that depends on prior-session context. Returns JSON `{ memories: [...] }`.",
    args: z.object({
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
        .describe(
          `Max memories to return (1..${RECALL_LIMIT_MAX}, default ${RECALL_LIMIT_DEFAULT}).`,
        ),
    }),
    run: async ({ q, limit }, { run, actorScope }) => {
      const memories = await recallMemories(run.packageId, run.spaceId, actorScope, {
        query: q,
        limit,
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
  }),
  defineTool({
    name: "run_history",
    title: "Read past runs",
    description:
      "Fetch metadata and optionally the carry-over checkpoint or final output of the agent's " +
      'most recent past runs (current run excluded). Returns JSON `{ object: "list", data: [...], hasMore }`. ' +
      "Use for trend analysis, auditing prior executions, or recovering from a failed run.",
    args: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(RUN_HISTORY_LIMIT_MAX)
        .optional()
        .describe(
          `Number of past runs to return (1..${RUN_HISTORY_LIMIT_MAX}, default ${RUN_HISTORY_LIMIT_DEFAULT}).`,
        ),
      fields: z
        .array(z.enum(RUN_HISTORY_FIELDS))
        .optional()
        .describe(`Optional subset of \`{${RUN_HISTORY_FIELDS.join(", ")}}\` to include per run.`),
    }),
    run: async ({ limit, fields }, { run }) => {
      const unique = [...new Set(fields ?? [])];
      // Actor isolation: `getRecentRuns` reads only the runs of the run's own
      // actor (the actor-less bucket for a scheduled run).
      const recent = await getRecentRuns(
        { orgId: run.orgId, spaceId: run.spaceId },
        run.packageId,
        actorFromIds(run.userId, run.endUserId),
        {
          ...(limit !== undefined ? { limit } : {}),
          ...(unique.length > 0 ? { fields: unique } : {}),
          excludeRunId: run.id,
        },
      );
      return textResult(JSON.stringify(listResponse(recent)));
    },
  }),
  defineTool({
    name: "notify",
    title: "Send a notification",
    description:
      "Send an in-app notification about this run — it appears in the notification bell and links to the run. " +
      "It reaches the run's recipients: the member or end-user who triggered the run, or the " +
      "organization's owners and admins for an unattended run. It is not instant: the bell shows it " +
      "when the run ends, on reconnect, or at the 5-minute poll. Each recipient receives ONE notification per run: a " +
      "second call is refused, so send it once, for what deserves attention (a result to review, a decision to make). " +
      `Title up to ${NOTIFY_TITLE_MAX} characters, message up to ${NOTIFY_MESSAGE_MAX}.`,
    args: z.object({
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
    }),
    run: async ({ title, message }, { run }) => {
      const scope = { orgId: run.orgId, spaceId: run.spaceId };
      const target = await resolveRunRecipients(scope, run.id);
      if (!target || target.recipients.length === 0) {
        return errorResult(
          "notify: nobody can be notified for this run (an ephemeral run, or no recipient); nothing was sent.",
        );
      }
      const inserted = await createAgentMessageNotifications(scope, target.run, target.recipients, {
        title,
        message,
      });
      if (inserted === 0) {
        return errorResult(
          "notify: this run already sent its notification; a run notifies each recipient once.",
        );
      }
      return textResult(`Notification sent to ${inserted} recipient(s)`);
    },
  }),
];

const RUN_TOOL_DESCRIPTIONS = new Map(
  RUN_TOOLS.map(({ descriptor }) => [descriptor.name, descriptor.description]),
);

/**
 * An integration resource with each tool of the runtime-bound integration described: its server
 * is this module, which lists the tools only to a run, so its catalog has no description of them.
 */
export function withRunToolDescriptions<
  T extends { manifest: unknown; tool_catalog: IntegrationToolCatalogEntry[] },
>(detail: T): T {
  if (!isRuntimeBoundIntegration(detail.manifest)) return detail;
  return {
    ...detail,
    tool_catalog: detail.tool_catalog.map((entry) => ({
      ...entry,
      description: RUN_TOOL_DESCRIPTIONS.get(entry.name) ?? entry.description,
    })),
  };
}

/** The tools bound to `run`. The run's actor decides the default persistence scope. */
function buildRunTools(run: RunToolsRun): AppstrateToolDefinition[] {
  const actorScope = scopeFromActor(actorFromIds(run.userId, run.endUserId));
  const ctx: ToolContext = {
    run,
    actorScope,
    scopeFor: (scope) => (scope === "shared" ? { type: "shared" } : actorScope),
  };
  return RUN_TOOLS.map((tool) => tool(ctx));
}

/**
 * Answer one MCP POST for `run`. The mount has already authenticated and
 * authorised it with a credential a cross-site page does not hold (the run
 * token, or the run's sink signature).
 *
 * A JSON-RPC batch is refused (MCP has no batching since protocol 2025-06-18):
 * the mounts' rate limiters charge one point per POST, which holds one message.
 */
export async function serveRunMcp(c: Context, run: RunToolsRun): Promise<Response> {
  const body = await c.req.arrayBuffer();
  const post = parseMcpPost(body);
  if (Array.isArray(post?.payload)) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request: JSON-RPC batching is not supported" },
        id: null,
      },
      400,
    );
  }
  const server = createMcpServer(buildRunTools(run), RUN_TOOLS_SERVER_INFO);
  return serveAuthenticatedStatelessPost(server, c.req.raw, body, post);
}
