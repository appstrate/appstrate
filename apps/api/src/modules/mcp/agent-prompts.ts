// SPDX-License-Identifier: Apache-2.0

/**
 * `prompts/list` and `prompts/get`: one launch prompt per agent the caller can
 * run, in every space of the connection where it may (`run_and_wait`'s own
 * surface). A prompt is user-controlled — clients expose it as a slash command
 * and the model cannot invoke it — so typing the command is what authorizes
 * the metered run.
 *
 * Every read is an in-process dispatch with the caller's credentials into the
 * prompt's space, so the routes' own guards decide: the agents are those of
 * `GET /api/agents`, and a prompt's contract is the agent detail at its latest
 * published version. An agent with no published version has no prompt.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppstratePromptProvider, GetPromptResult, Prompt } from "@appstrate/mcp-transport";
import {
  agentPromptDescription,
  agentPromptName,
  renderAgentPrompt,
  scopeCollisionPromptName,
  spaceCollisionPromptName,
  type AgentLaunchView,
} from "@appstrate/core/agent-prompt";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import type { Dispatch, McpSurface } from "./tools.ts";
import { dispatchHeaders } from "./tool-results.ts";

/** A space the connection reaches, as the prompts need it. */
export interface PromptSpace {
  id: string;
  name: string;
  surface: Pick<McpSurface, "runs">;
}

export interface AgentPromptContext {
  origin: string;
  authHeaders: Headers;
  dispatch: Dispatch;
  spaces: readonly PromptSpace[];
}

interface NamedAgent {
  name: string;
  packageId: string;
  spaceId: string;
}

const REQUEST_ARGUMENT = {
  name: "request",
  description:
    "What to run the agent on, in your own words. The model builds the run's input from it.",
  required: false,
};

function get(ctx: AgentPromptContext, spaceId: string, path: string): Promise<Response> {
  const headers = dispatchHeaders(ctx.authHeaders);
  headers.set("x-space-id", spaceId);
  return ctx.dispatch(
    new Request(new URL(path, ctx.origin).toString(), { method: "GET", headers }),
  );
}

async function listAgentIds(ctx: AgentPromptContext, spaceId: string): Promise<string[]> {
  const response = await get(ctx, spaceId, "/api/agents");
  if (!response.ok) return [];
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && parseScopedName(id) !== null)
    .sort();
}

/**
 * Names in space order, then package id order. The first claimant of
 * `run-<name>` keeps it; the same agent in a later space takes
 * `run-<space>-<name>`, another agent with the same name `run-<scope>-<name>`.
 */
async function nameAgents(ctx: AgentPromptContext): Promise<NamedAgent[]> {
  const spaces = ctx.spaces.filter((space) => space.surface.runs);
  const listed = await Promise.all(spaces.map((space) => listAgentIds(ctx, space.id)));
  const taken = new Set<string>();
  const named: NamedAgent[] = [];
  spaces.forEach((space, i) => {
    for (const packageId of listed[i]!) {
      const segment = parseScopedName(packageId)!.name;
      const preferred = agentPromptName(segment);
      const name = !taken.has(preferred)
        ? preferred
        : named.some((agent) => agent.packageId === packageId)
          ? spaceCollisionPromptName(segment, space.name, taken)
          : scopeCollisionPromptName(packageId, taken);
      taken.add(name);
      named.push({ name, packageId, spaceId: space.id });
    }
  });
  return named;
}

/** The agent's launch contract at its latest published version, or `null` when it has none. */
async function resolveAgent(
  ctx: AgentPromptContext,
  agent: NamedAgent,
): Promise<AgentLaunchView | null> {
  const response = await get(
    ctx,
    agent.spaceId,
    `/api/packages/agents/${encodePackageIdPath(agent.packageId)}?version=latest`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    display_name?: unknown;
    description?: unknown;
    version?: unknown;
    input?: AgentLaunchView["input"];
  };
  const input = body.input;
  if (typeof body.version !== "string" || !input || !Array.isArray(input.locked_fields)) {
    return null;
  }
  return {
    packageId: agent.packageId,
    spaceId: agent.spaceId,
    version: body.version,
    title:
      typeof body.display_name === "string" && body.display_name.trim()
        ? body.display_name
        : agent.packageId,
    description: typeof body.description === "string" ? body.description : "",
    input,
  };
}

function toPrompt(name: string, view: AgentLaunchView): Prompt {
  return {
    name,
    title: view.title,
    description: agentPromptDescription(view),
    arguments: [REQUEST_ARGUMENT],
  };
}

export function buildAgentPromptProvider(ctx: AgentPromptContext): AppstratePromptProvider {
  return {
    list: async () => {
      const named = await nameAgents(ctx);
      const views = await Promise.all(named.map((agent) => resolveAgent(ctx, agent)));
      return named.flatMap((agent, i) => {
        const view = views[i];
        return view ? [toPrompt(agent.name, view)] : [];
      });
    },
    get: async (name, args): Promise<GetPromptResult> => {
      const agent = (await nameAgents(ctx)).find((candidate) => candidate.name === name);
      const view = agent ? await resolveAgent(ctx, agent) : null;
      // One answer for unknown and unlaunchable names: the error never confirms an agent exists.
      if (!view) throw new McpError(ErrorCode.InvalidParams, `Invalid prompt name: ${name}`);
      return {
        description: agentPromptDescription(view),
        messages: [
          { role: "user", content: { type: "text", text: renderAgentPrompt(view, args.request) } },
        ],
      };
    },
  };
}
