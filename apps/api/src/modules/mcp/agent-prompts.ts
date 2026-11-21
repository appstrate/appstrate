// SPDX-License-Identifier: Apache-2.0

/**
 * `prompts/list` and `prompts/get`: one launch prompt per agent the caller can
 * run, in every space of the connection where it may (`run_and_wait`'s own
 * surface). A prompt is user-controlled — clients expose it as a slash command
 * and the model cannot invoke it — so typing the command is what authorizes
 * the metered run.
 *
 * Every read is an in-process dispatch with the caller's credentials into the
 * prompt's space, so the routes' own guards decide. `prompts/list` reads only
 * `GET /api/agents`, once per space: its `published` rows are the prompts (an
 * agent with no published version has none). `prompts/get` reads that list to
 * resolve the name, then the requested agent's detail at its latest published
 * version for its input contract.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppstratePromptProvider, GetPromptResult, Prompt } from "@appstrate/mcp-transport";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import {
  agentPromptDescription,
  agentPromptName,
  renderAgentPrompt,
  scopeCollisionPromptName,
  spaceCollisionPromptName,
  type AgentLaunchView,
} from "./agent-prompt-render.ts";
import type { Dispatch, McpSurface } from "./tools.ts";
import { dispatchGet, listAgents, readSpaces } from "./discovery.ts";

/** A space the connection reaches, as the prompts need it. */
export interface PromptSpace {
  id: string;
  name: string;
  surface: Pick<McpSurface, "runs">;
}

export interface AgentPromptContext {
  origin: string;
  authHeaders: Headers;
  /** A dispatch run in one of `spaces`. */
  dispatchIn: (spaceId: string) => Dispatch;
  spaces: readonly PromptSpace[];
  /** Whether the connection's tools take `space_id`: `false` when pinned to one space. */
  namesSpace: boolean;
}

/** A published agent of a space, with the prompt name it gets. */
interface NamedAgent {
  packageId: string;
  title: string;
  description: string;
  name: string;
  spaceId: string;
}

const REQUEST_ARGUMENT = {
  name: "request",
  description:
    "What to run the agent on, in your own words. The model builds the run's input from it.",
  required: false,
};

/** `ctx` reading in `spaceId`. */
const readingIn = (ctx: AgentPromptContext, spaceId: string) => ({
  origin: ctx.origin,
  authHeaders: ctx.authHeaders,
  dispatch: ctx.dispatchIn(spaceId),
});

/**
 * Names in space order, then package id order, over published agents only. The
 * first claimant of `run-<name>` keeps it; the same agent in a later space
 * takes `run-<space>-<name>`, another agent with the same name
 * `run-<scope>-<name>`.
 */
async function nameAgents(ctx: AgentPromptContext): Promise<NamedAgent[]> {
  const { answered } = await readSpaces(
    ctx.spaces.filter((space) => space.surface.runs),
    (space) => listAgents(readingIn(ctx, space.id)),
  );
  const taken = new Set<string>();
  const named: NamedAgent[] = [];
  for (const { space, value } of answered) {
    const published = value.agents
      .filter((agent) => agent.published)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { id, display_name: title, description } of published) {
      const segment = parseScopedName(id)!.name;
      const preferred = agentPromptName(segment);
      const name = !taken.has(preferred)
        ? preferred
        : named.some((other) => other.packageId === id)
          ? spaceCollisionPromptName(segment, space.name, taken)
          : scopeCollisionPromptName(id, taken);
      taken.add(name);
      named.push({ packageId: id, title, description, name, spaceId: space.id });
    }
  }
  return named;
}

/** The agent's launch contract at its latest published version, or `null` when it has none. */
async function resolveAgent(
  ctx: AgentPromptContext,
  agent: NamedAgent,
): Promise<AgentLaunchView | null> {
  const response = await dispatchGet(
    readingIn(ctx, agent.spaceId),
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
    ...(ctx.namesSpace ? { spaceId: agent.spaceId } : {}),
    version: body.version,
    title:
      typeof body.display_name === "string" && body.display_name.trim()
        ? body.display_name
        : agent.packageId,
    description: typeof body.description === "string" ? body.description : "",
    input,
  };
}

function toPrompt(agent: NamedAgent): Prompt {
  return {
    name: agent.name,
    title: agent.title,
    description: agentPromptDescription(agent),
    arguments: [REQUEST_ARGUMENT],
  };
}

export function buildAgentPromptProvider(ctx: AgentPromptContext): AppstratePromptProvider {
  return {
    list: async () => (await nameAgents(ctx)).map(toPrompt),
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
