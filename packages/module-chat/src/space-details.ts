// SPDX-License-Identifier: Apache-2.0

/**
 * What the spaces a conversation works in hold (integrations, agents), read with `get_me` at the
 * start of a turn and rendered BY RESOURCE: one line per integration or agent naming the spaces
 * where it stands. Nothing in it ranks: entries are sorted by id, spaces by name, every space is
 * rendered at the same level of detail, and a list is given whole or not at all — a count stands in
 * for one `get_me` capped, as a partial list would put its first entries before the others. The
 * rendering sits under the system prompt's single cache breakpoint: a pure function of the reads.
 */

import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { flattenName } from "@appstrate/core/mcp-spaces";
import { getMeResultSchema } from "@appstrate/core/me-context";
import { logger } from "./logger.ts";

/** About 2k tokens. */
export const CHAT_CONTEXT_DETAILS_BUDGET_CHARS = 8_000;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** At most this many spaces are read per turn, in the order the caller gives them; the rest are counted. */
export const MAX_DETAIL_SPACES = 20;

/**
 * The spaces a turn reads, in priority order: the origin space, the caller's personal space, the
 * spaces the conversation touched, then the others by name and id.
 */
export function orderDetailSpaces<T extends { id: string; name: string }>(
  spaces: readonly T[],
  priority: readonly (string | null | undefined)[],
): T[] {
  const rank = new Map<string, number>();
  for (const id of priority) if (id != null && !rank.has(id)) rank.set(id, rank.size);
  const rest = rank.size;
  const rankOf = (id: string) => rank.get(id) ?? rest;
  return [...spaces].sort(
    (a, b) =>
      rankOf(a.id) - rankOf(b.id) ||
      (rankOf(a.id) < rest ? 0 : compare(a.name, b.name) || compare(a.id, b.id)),
  );
}

/** How many `get_me` run at once: a huge organization must not flood the connection the skills share. */
const READ_CONCURRENCY = 4;

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

/**
 * One space as read: a list is `null` when the turn may not read it there, and a total above its
 * length means `get_me` capped it.
 */
export interface SpaceDetail {
  space: DetailSpace;
  integrations: IntegrationEntry[] | null;
  connectable: string[];
  connectableTotal: number;
  agents: AgentEntry[] | null;
  agentsTotal: number;
}

export type SpaceDetailsClient = Pick<AppstrateMcpClient, "callTool">;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The `get_me` payload of one space, or `undefined` when it is not a well-formed 200 answer. */
function parseDetail(space: DetailSpace, result: unknown): SpaceDetail | undefined {
  const answer = record(result);
  const outcome = record(answer.structuredContent);
  if (answer.isError === true || outcome.status !== 200) return undefined;
  const parsed = getMeResultSchema.safeParse(outcome);
  if (!parsed.success) {
    logger.warn("get_me of a space answered a context of an unexpected shape — left out", {
      spaceId: space.id,
      issues: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return undefined;
  }
  const { body } = parsed.data;
  const {
    connections,
    connectable_integrations: connectableEnvelope,
    agents: agentsEnvelope,
  } = body;
  if (
    body.space?.id !== space.id ||
    connections === undefined ||
    connectableEnvelope === undefined ||
    agentsEnvelope === undefined
  )
    return undefined;
  const total = (value: number, listed: unknown[] | null): number =>
    listed === null ? 0 : Math.max(value, listed.length);
  const connectable = space.integrations ? connectableEnvelope.data : null;
  const agents = space.agents
    ? agentsEnvelope.data.map((entry) => ({
        id: entry.packageId,
        name: entry.display_name,
        description: entry.description,
        published: entry.published,
        homeWritable: entry.home_writable,
        takesInput: entry.takes_input,
        inactiveRequired: entry.inactive_required_integrations,
      }))
    : null;
  return {
    space,
    integrations: space.integrations
      ? connections.map((entry) => ({
          id: entry.integration_package_id,
          name: entry.name,
          active: entry.active,
          needsReconnection: entry.needs_reconnection === true,
          connections: entry.connections.map((c) => ({
            id: c.id,
            label: c.label,
            owned: c.owned_by_actor,
          })),
        }))
      : null,
    connectable: connectable ?? [],
    connectableTotal: total(connectableEnvelope.total, connectable),
    agents,
    agentsTotal: total(agentsEnvelope.total, agents),
  };
}

/**
 * `get_me` in each of `spaces`, a few at a time, over `client`, in the order of `spaces`. A space
 * whose read fails, is refused or answers malformed is left out: the turn goes on and the model
 * reads it with its tools.
 */
export async function readSpaceDetails(
  client: SpaceDetailsClient,
  signal: AbortSignal,
  spaces: readonly DetailSpace[],
): Promise<SpaceDetail[]> {
  const read = (space: DetailSpace): Promise<SpaceDetail | undefined> =>
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
    );
  const details = new Array<SpaceDetail | undefined>(spaces.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, spaces.length) }, async () => {
      while (next < spaces.length) {
        const at = next++;
        details[at] = await read(spaces[at]!);
      }
    }),
  );
  return details.filter((detail): detail is SpaceDetail => detail !== undefined);
}

const oneLine = flattenName;
const label = (value: string): string => oneLine(value, 80);
const head = (id: string, name: string): string => {
  const shown = label(name);
  return shown && shown !== id ? `\`${id}\` (${shown})` : `\`${id}\``;
};
const names = (spaces: readonly DetailSpace[]): string =>
  spaces.map((space) => label(space.name)).join(", ");
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** How much of each entry is rendered, the same for every space: the most that fits the budget. */
const LEVELS = ["full", "names", "counts"] as const;
type Level = (typeof LEVELS)[number];

/** Whether `get_me` listed the whole of a list, which alone is rendered entry by entry. */
const listsAgents = (detail: SpaceDetail): boolean =>
  detail.agents !== null && detail.agentsTotal <= detail.agents.length;
const listsConnectable = (detail: SpaceDetail): boolean =>
  detail.connectableTotal <= detail.connectable.length;

/** The integrations the details name, one line each, sorted by id. */
function integrationLines(details: readonly SpaceDetail[], level: Level): string[] {
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
    if (listsConnectable(detail)) {
      for (const id of detail.connectable) at(id).unconnected.push(detail.space);
    }
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
    const connections =
      level === "full"
        ? [...entry.connections.values()].map(
            (connection) =>
              `${JSON.stringify(label(connection.label))} (${connection.owned ? "yours" : "a colleague's"})`,
          )
        : [];
    return `- ${head(id, entry.name)} — ${where.join("; ")}${
      connections.length ? `. Connections: ${connections.join(", ")}` : ""
    }`;
  });
}

/** The agents the details list whole, one line each, sorted by id. */
function agentLines(details: readonly SpaceDetail[], level: Level): string[] {
  const byId = new Map<
    string,
    { agent: AgentEntry; in: { space: DetailSpace; agent: AgentEntry }[] }
  >();
  for (const detail of details.filter(listsAgents)) {
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
    const description = level === "full" ? oneLine(agent.description, DESCRIPTION_MAX_CHARS) : "";
    return `- ${head(id, agent.name)} — in ${where.join(", ")}${agent.takesInput ? "; takes input" : ""}${
      description ? `. ${description}` : ""
    }`;
  });
}

/**
 * The line naming the spaces where `get_me` capped a list, which is counted, never cut. Such a
 * space is left out of every entry above, so `elsewhere` says an entry may stand there too.
 */
const countedLine = (
  what: string,
  elsewhere: string,
  counted: { space: DetailSpace; total: number }[],
): string[] =>
  counted.length
    ? [
        `${what} are only counted where they outnumber what \`get_me\` lists: ${counted
          .map(({ space, total }) => `${label(space.name)} (${total})`)
          .join(", ")}; \`search\` with the space's \`space_id\` finds them, and ${elsewhere}.`,
      ]
    : [];

/** Every entry of `details`, at `level`. */
function renderLists(details: readonly SpaceDetail[], level: "full" | "names"): string[] {
  const lines = [`As read at the start of this turn, for ${names(details.map((d) => d.space))}.`];
  if (level === "names") {
    lines.push(
      "Descriptions and connection labels are left out for room: `get_me` with a space's `space_id` gives them.",
    );
  }
  const readsIntegrations = details.filter((detail) => detail.integrations !== null);
  if (readsIntegrations.length > 0) {
    const integrations = integrationLines(readsIntegrations, level);
    const counted = readsIntegrations
      .filter((detail) => !listsConnectable(detail))
      .map((detail) => ({ space: detail.space, total: detail.connectableTotal }));
    lines.push(
      "",
      "Integrations:",
      ...(integrations.length || counted.length
        ? integrations
        : ["- none connected or to connect"]),
      ...countedLine(
        "Integrations to connect",
        "an integration listed above may also be to connect there",
        counted,
      ),
    );
  }
  const readsAgents = details.filter((detail) => detail.agents !== null);
  if (readsAgents.length > 0) {
    const agents = agentLines(readsAgents, level);
    const counted = readsAgents
      .filter((detail) => !listsAgents(detail))
      .map((detail) => ({ space: detail.space, total: detail.agentsTotal }));
    lines.push(
      "",
      "Agents:",
      ...(agents.length || counted.length ? agents : ["- none active"]),
      ...countedLine("Agents", "an agent listed above may also be active there", counted),
    );
  }
  for (const detail of details) {
    const name = label(detail.space.name);
    if (detail.integrations === null)
      lines.push(`Your role does not read the integrations of ${name}.`);
    else if (detail.agents === null) lines.push(`Your role does not run agents in ${name}.`);
  }
  return lines;
}

/** What `details` hold, counted space by space. */
function renderCounts(details: readonly SpaceDetail[]): string[] {
  return [
    "As read at the start of this turn, only counted for room: `get_me` with a space's `space_id` lists them.",
    ...details.map((detail) => {
      const parts = [
        detail.integrations === null
          ? "your role does not read its integrations"
          : `${count(
              detail.integrations.filter(
                (integration) => integration.active && !integration.needsReconnection,
              ).length,
              "usable integration",
              "usable integrations",
            )}, ${detail.connectableTotal} to connect`,
        detail.agents === null
          ? "your role does not run its agents"
          : count(detail.agentsTotal, "agent", "agents"),
      ];
      return `- ${label(detail.space.name)}: ${parts.join("; ")}`;
    }),
  ];
}

/** Whether `detail` puts at least one entry, or a count of some, into the rendering. */
function showsEntries(detail: SpaceDetail): boolean {
  return (
    (detail.integrations?.length ?? 0) > 0 || detail.connectableTotal > 0 || detail.agentsTotal > 0
  );
}

/**
 * What `details` hold at the most detailed level whose rendering fits `budget`, every space at that
 * same level, and the spaces it shows an entry of.
 */
export function formatSpaceDetails(
  details: readonly SpaceDetail[],
  budget = CHAT_CONTEXT_DETAILS_BUDGET_CHARS,
  unread = 0,
): { text: string; shown: string[] } {
  if (details.length === 0 && unread === 0) return { text: "", shown: [] };
  const unreadLine =
    unread > 0
      ? [
          `${unread} ${unread === 1 ? "space" : "spaces"} not read; call \`get_me\` with \`space_id\` for ${unread === 1 ? "it" : "one of them"}.`,
        ]
      : [];
  const spaces = [...details].sort(
    (a, b) => compare(a.space.name, b.space.name) || compare(a.space.id, b.space.id),
  );
  const shown = spaces.filter(showsEntries).map((detail) => detail.space.id);
  for (const level of LEVELS) {
    const text = [
      SPACE_DETAILS_HEADING,
      ...(spaces.length === 0
        ? []
        : level === "counts"
          ? renderCounts(spaces)
          : renderLists(spaces, level)),
      ...unreadLine,
    ].join("\n");
    if (text.length <= budget) return { text, shown };
  }
  const text = [
    SPACE_DETAILS_HEADING,
    "Not detailed here, for room: `get_me` with a space's `space_id` lists what it holds.",
    ...unreadLine,
  ].join("\n");
  return { text: text.length <= budget ? text : "", shown: [] };
}
