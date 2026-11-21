// SPDX-License-Identifier: Apache-2.0

// The one row shape every package collection draws (cards and table), and its builders.

import type { ReactNode } from "react";
import type { PackageType } from "@appstrate/core/validation";
import type { AgentListIntegration, AgentListItem } from "@appstrate/shared-types";

export interface CardItem {
  id: string;
  /** Every space whose index lists it (`space_ids`): where its actions may act. Its link opens in the current one when listed there, else enters the first (`rowSpace`). Absent off an index (the catalogue). */
  spaceIds?: string[];
  /** The package's home space when the reader reaches it, `null` when withheld; undefined off an index (the catalogue). */
  homeSpaceId?: string | null;
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
  /** The integrations an agent uses that take a connection, drawn as a stack of their logos. */
  integrations?: AgentListIntegration[];
  /** Of those, the required ones not active in the space (single-space index only). */
  inactiveIntegrations?: string[];
  /** An integration's logo (its manifest `icon`). */
  logo?: string;
  /** The card's state, top right. */
  status?: ReactNode;
  /** One muted line under the description. */
  meta?: ReactNode;
}

export function agentCardItem(agent: AgentListItem): CardItem {
  return {
    id: agent.id,
    spaceIds: agent.space_ids,
    homeSpaceId: agent.home_space_id,
    displayName: agent.display_name ?? agent.id,
    description: agent.description ?? null,
    type: "agent",
    source: agent.source,
    version: agent.version,
    runningRuns: agent.running_runs,
    keywords: agent.keywords,
    unreadCount: agent.unread_count,
    identity: { icon: agent.icon, color: agent.color },
    // Only those the reader connects: an unauthenticated one (the platform's own tools) asks
    // nothing of them, and would sit on every agent's stack.
    integrations: agent.integrations.filter((integration) => integration.authenticated),
    inactiveIntegrations: agent.inactive_required_integrations,
  };
}

/** What every package index row (`usePackageList`) carries, whatever its type. */
interface PackageIndexRow {
  id: string;
  space_ids: string[];
  home_space_id?: string | null;
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
    spaceIds: row.space_ids,
    homeSpaceId: row.home_space_id,
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
