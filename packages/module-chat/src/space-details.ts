// SPDX-License-Identifier: Apache-2.0

/**
 * What the spaces a conversation works in hold (integrations, agents), read with `get_me` at the
 * start of a turn and rendered BY RESOURCE: one line per integration or agent naming the spaces
 * where it stands. The rendering sits under the system prompt's single cache breakpoint, so it is a
 * pure function of what was read: entries sorted by id, spaces in the order given.
 */

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { logger } from "./logger.ts";

/** About 2k tokens: two spaces each listing the 15 agents `get_me` caps its list at. */
export const CHAT_CONTEXT_DETAILS_BUDGET_CHARS = 8_000;

export const SPACE_DETAILS_HEADING = "## What these spaces hold";

const DESCRIPTION_MAX_CHARS = 160;

/** A space to read, with what the turn may read there (`integrations:read`, `agents:run`). */
export interface DetailSpace {
  id: string;
  name: string;
  integrations: boolean;
  agents: boolean;
}

interface IntegrationEntry {
  id: string;
  name: string;
  active: boolean;
  needsReconnection: boolean;
  connections: { id: string; label: string; owned: boolean }[];
}

interface AgentEntry {
  id: string;
  name: string;
  description: string;
  published: boolean;
  homeWritable: boolean;
  takesInput: boolean;
  inactiveRequired: string[];
}

/** One space as read: a list is `null` when the turn may not read it there. */
export interface SpaceDetail {
  space: DetailSpace;
  integrations: IntegrationEntry[] | null;
  connectable: string[];
  connectableTruncated: boolean;
  agents: AgentEntry[] | null;
  agentsTotal: number;
}

export type SpaceDetailsClient = Pick<AppstrateMcpClient, "callTool">;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const withId = <T extends { id: string }>(entries: T[]): T[] => entries.filter((entry) => entry.id);

/** The `get_me` payload of one space, or `undefined` when it is not a 200 answer. */
function parseDetail(space: DetailSpace, result: unknown): SpaceDetail | undefined {
  const outcome = record(record(result).structuredContent);
  if (record(result).isError === true || outcome.status !== 200) return undefined;
  const body = record(outcome.body);
  if (record(body.space).id !== space.id) return undefined;
  return {
    space,
    integrations: space.integrations
      ? withId(
          list(body.connections).map((item) => {
            const entry = record(item);
            return {
              id: text(entry.integration_package_id),
              name: text(entry.name),
              active: entry.active === true,
              needsReconnection: entry.needs_reconnection === true,
              connections: withId(
                list(entry.connections).map((connection) => {
                  const c = record(connection);
                  return { id: text(c.id), label: text(c.label), owned: c.owned_by_actor === true };
                }),
              ),
            };
          }),
        )
      : null,
    connectable: space.integrations
      ? list(body.connectable_integrations).map(text).filter(Boolean)
      : [],
    connectableTruncated: space.integrations && body.connectable_integrations_truncated === true,
    agents: space.agents
      ? withId(
          list(body.agents).map((item) => {
            const entry = record(item);
            return {
              id: text(entry.packageId),
              name: text(entry.display_name),
              description: text(entry.description),
              published: entry.published === true,
              homeWritable: entry.home_writable === true,
              takesInput: entry.takes_input === true,
              inactiveRequired: list(entry.inactive_required_integrations).map(text),
            };
          }),
        )
      : null,
    agentsTotal: typeof body.agents_total === "number" ? body.agents_total : 0,
  };
}

/**
 * `get_me` in each of `spaces`, in parallel, over `client`. A space whose read fails, is refused
 * or answers malformed is left out: the turn goes on and the model reads it with its tools.
 */
export async function readSpaceDetails(
  client: SpaceDetailsClient,
  signal: AbortSignal,
  spaces: readonly DetailSpace[],
): Promise<SpaceDetail[]> {
  const read = await Promise.all(
    spaces.map((space) =>
      client.callTool({ name: "get_me", arguments: { space_id: space.id } }, { signal }).then(
        (result) => {
          const detail = parseDetail(space, result);
          if (!detail)
            logger.warn("get_me of a space answered no context — left out", { spaceId: space.id });
          return detail;
        },
        (err: unknown) => {
          logger.warn("get_me of a space failed — left out", {
            spaceId: space.id,
            err: String(err),
          });
          return undefined;
        },
      ),
    ),
  );
  return read.filter((detail): detail is SpaceDetail => detail !== undefined);
}

const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const label = (value: string): string => oneLine(value, 80);
const head = (id: string, name: string): string => {
  const shown = label(name);
  return shown && shown !== id ? `\`${id}\` (${shown})` : `\`${id}\``;
};
const names = (spaces: readonly DetailSpace[]): string =>
  spaces.map((space) => label(space.name)).join(", ");

/** The integrations the details name, one line each, sorted by id. */
function integrationLines(details: readonly SpaceDetail[]): string[] {
  const byId = new Map<
    string,
    {
      name: string;
      usable: DetailSpace[];
      reconnect: DetailSpace[];
      off: DetailSpace[];
      unconnected: DetailSpace[];
      connections: Map<string, { label: string; owned: boolean }>;
    }
  >();
  const at = (id: string, name = "") => {
    let entry = byId.get(id);
    if (!entry) {
      entry = { name, usable: [], reconnect: [], off: [], unconnected: [], connections: new Map() };
      byId.set(id, entry);
    }
    if (!entry.name && name) entry.name = name;
    return entry;
  };
  for (const detail of details) {
    for (const integration of detail.integrations ?? []) {
      const entry = at(integration.id, integration.name);
      (!integration.active
        ? entry.off
        : integration.needsReconnection
          ? entry.reconnect
          : entry.usable
      ).push(detail.space);
      for (const connection of integration.connections) {
        if (!entry.connections.has(connection.id)) entry.connections.set(connection.id, connection);
      }
    }
    for (const id of detail.connectable) at(id).unconnected.push(detail.space);
  }
  return [...byId.keys()].sort().map((id) => {
    const entry = byId.get(id)!;
    const where = [
      entry.usable.length ? `usable in ${names(entry.usable)}` : "",
      entry.reconnect.length
        ? `its connection must be reconnected in ${names(entry.reconnect)}`
        : "",
      entry.off.length ? `switched off in ${names(entry.off)}` : "",
      entry.unconnected.length ? `not connected in ${names(entry.unconnected)}` : "",
    ].filter(Boolean);
    const connections = [...entry.connections.values()].map(
      (connection) =>
        `${JSON.stringify(label(connection.label))} (${connection.owned ? "yours" : "a colleague's"})`,
    );
    return `- ${head(id, entry.name)} — ${where.join("; ")}${
      connections.length ? `. Connections: ${connections.join(", ")}` : ""
    }`;
  });
}

/** The agents the details name, one line each, sorted by id. */
function agentLines(details: readonly SpaceDetail[]): string[] {
  const byId = new Map<
    string,
    { agent: AgentEntry; in: { space: DetailSpace; agent: AgentEntry }[] }
  >();
  for (const detail of details) {
    for (const agent of detail.agents ?? []) {
      const entry = byId.get(agent.id) ?? { agent, in: [] };
      entry.in.push({ space: detail.space, agent });
      byId.set(agent.id, entry);
    }
  }
  return [...byId.keys()].sort().map((id) => {
    const { agent, in: placements } = byId.get(id)!;
    const where = placements.map(({ space, agent: here }) => {
      const notes = [
        here.published
          ? ""
          : here.homeWritable
            ? "draft only: launch it with version=draft"
            : "draft only: not launchable by you",
        here.inactiveRequired.length
          ? `refused until ${here.inactiveRequired.map((integration) => `\`${integration}\``).join(", ")} ${here.inactiveRequired.length > 1 ? "are" : "is"} switched on`
          : "",
      ].filter(Boolean);
      return `${label(space.name)}${notes.length ? ` (${notes.join("; ")})` : ""}`;
    });
    const description = oneLine(agent.description, DESCRIPTION_MAX_CHARS);
    return `- ${head(id, agent.name)} — in ${where.join(", ")}${agent.takesInput ? "; takes input" : ""}${
      description ? `. ${description}` : ""
    }`;
  });
}

/** The rendering of `details`, naming the `omitted` spaces left to `get_me`; `""` for neither. */
function renderAll(details: readonly SpaceDetail[], omitted: readonly DetailSpace[]): string {
  if (details.length === 0 && omitted.length === 0) return "";
  const lines = [SPACE_DETAILS_HEADING];
  if (details.length > 0) {
    lines.push(`As read at the start of this turn, for ${names(details.map((d) => d.space))}.`);
  }
  if (omitted.length > 0) {
    lines.push(`Not detailed here, for room: ${names(omitted)}; \`get_me\` with its \`space_id\`.`);
  }
  const readsIntegrations = details.filter((detail) => detail.integrations !== null);
  if (readsIntegrations.length > 0) {
    const integrations = integrationLines(readsIntegrations);
    lines.push(
      "",
      "Integrations:",
      ...(integrations.length ? integrations : ["- none connected or to connect"]),
    );
    const capped = readsIntegrations.filter((detail) => detail.connectableTruncated);
    if (capped.length) {
      lines.push(
        `More integrations to connect in ${names(capped.map((detail) => detail.space))}: \`search\` lists them.`,
      );
    }
  }
  const readsAgents = details.filter((detail) => detail.agents !== null);
  if (readsAgents.length > 0) {
    const agents = agentLines(readsAgents);
    lines.push("", "Agents:", ...(agents.length ? agents : ["- none active"]));
    const capped = readsAgents.filter(
      (detail) => detail.agentsTotal > (detail.agents?.length ?? 0),
    );
    if (capped.length) {
      lines.push(
        `Only the first agents are listed for ${capped
          .map(
            (detail) =>
              `${label(detail.space.name)} (${detail.agents!.length} of ${detail.agentsTotal})`,
          )
          .join(", ")}: \`search\` finds the others.`,
      );
    }
  }
  const skipped = details.filter(
    (detail) => detail.integrations === null || detail.agents === null,
  );
  for (const detail of skipped) {
    const name = label(detail.space.name);
    lines.push(
      detail.integrations === null
        ? `Your role does not read the integrations of ${name}.`
        : `Your role does not run agents in ${name}.`,
    );
  }
  return lines.join("\n");
}

/** Whether `detail` puts at least one entry of its space into the rendering: an absence is no data. */
function showsEntries(detail: SpaceDetail): boolean {
  return (
    (detail.integrations?.length ?? 0) > 0 ||
    detail.connectable.length > 0 ||
    (detail.agents?.length ?? 0) > 0
  );
}

/**
 * The first spaces of `details` whose rendering fits `budget`, the rest named as left to `get_me`,
 * and the spaces it shows an entry of.
 */
export function formatSpaceDetails(
  details: readonly SpaceDetail[],
  budget = CHAT_CONTEXT_DETAILS_BUDGET_CHARS,
): { text: string; shown: string[] } {
  for (let kept = details.length; kept >= 0; kept--) {
    const included = details.slice(0, kept);
    const text = renderAll(
      included,
      details.slice(kept).map((detail) => detail.space),
    );
    if (text.length <= budget) {
      return { text, shown: included.filter(showsEntries).map((detail) => detail.space.id) };
    }
  }
  return { text: "", shown: [] };
}
