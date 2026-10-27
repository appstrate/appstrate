// SPDX-License-Identifier: Apache-2.0

// The one row shape every package collection draws (cards and table), and its builders.

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
  unreadCount?: number;
  actions?: ReactNode;
  autoInstalled?: boolean;
  /** A tile drawn left of the title, instead of the one the type and identity give. */
  icon?: ReactNode;
  /** An agent's chosen icon and colour. */
  identity?: { icon?: string | null; color?: string | null };
  /** An integration's logo (its manifest `icon`). */
  logo?: string;
  /** The card's state, top right. */
  status?: ReactNode;
  /** One muted line under the description. */
  meta?: ReactNode;
}

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
