// SPDX-License-Identifier: Apache-2.0

/**
 * The one row shape every package collection draws (cards and table alike),
 * and the builders that make it from what each list endpoint returns. A
 * surface that shows an agent, a skill or an MCP server builds its row here,
 * so the dashboard, the index pages and « Utilisé par » never map it by hand.
 */

import type { ReactNode } from "react";
import type { PackageType } from "@appstrate/core/validation";
import type { AgentListItem } from "@appstrate/shared-types";

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  /** The version the space runs, drawn as a mono badge on the card. */
  version?: string | null;
  runningRuns?: number;
  keywords?: string[];
  usedByAgents?: number;
  /** An integration's connections of the caller here; the card says nothing at 0 or unknown. */
  connectionCount?: number;
  unreadCount?: number;
  actions?: ReactNode;
  autoInstalled?: boolean;
  /** A tile drawn left of the title, instead of the one the type and identity give. */
  icon?: ReactNode;
  /** An agent's chosen icon and colour: its identity tile, in the cards and the table alike. */
  identity?: { icon?: string | null; color?: string | null };
  /** An integration's logo (its manifest `icon`), next to its name. */
  logo?: string;
  /** The card's state, top right: what a browsing reader looks for first. */
  status?: ReactNode;
  /** One muted line under the description: who provides it, what it carries. */
  meta?: ReactNode;
}

/** An agent of the index (`useAgents`), with its unread runs when the surface counts them. */
export function agentCardItem(agent: AgentListItem, unreadCount?: number): CardItem {
  return {
    id: agent.id,
    displayName: agent.display_name ?? agent.id,
    description: agent.description ?? null,
    type: "agent",
    source: agent.source,
    version: agent.version,
    runningRuns: agent.running_runs,
    keywords: agent.keywords,
    unreadCount,
    identity: { icon: agent.icon, color: agent.color },
  };
}

/** What every package index row (`usePackageList`) carries, whatever its type. */
interface PackageIndexRow {
  id: string;
  name?: string | null;
  description?: string | null;
  source?: "system" | "local";
  version?: string | null;
  icon?: string | null;
  keywords?: string[] | null;
  used_by_agents?: number;
  auto_installed?: boolean;
}

/** A skill, MCP server or integration of the space's index. */
export function packageCardItem(row: PackageIndexRow, type: PackageType): CardItem {
  return {
    id: row.id,
    displayName: row.name || row.id,
    description: row.description ?? null,
    type,
    source: row.source,
    version: row.version,
    keywords: row.keywords ?? undefined,
    usedByAgents: row.used_by_agents,
    autoInstalled: row.auto_installed,
    logo: type === "integration" ? (row.icon ?? undefined) : undefined,
  };
}
