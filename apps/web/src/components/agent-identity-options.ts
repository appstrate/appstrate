// SPDX-License-Identifier: Apache-2.0

import { iconNames, type IconName } from "lucide-react/dynamic";
import {
  LUCIDE_ICON_PREFIX,
  parseManifestIcon,
  type ManifestIcon,
} from "@appstrate/core/manifest-icon";

export const AGENT_ICON_NAMES = iconNames;
export type AgentIconName = IconName;

const AGENT_ICON_NAME_SET = new Set<string>(AGENT_ICON_NAMES);

export const AGENT_COLOR_CATALOG = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
} as const;

export type AgentColorKey = keyof typeof AGENT_COLOR_CATALOG;

/** The icon an agent without a drawable one shows. */
const DEFAULT_AGENT_ICON: ManifestIcon = { kind: "lucide", name: "bot" };

export function isLucideIconName(value: string): value is AgentIconName {
  return AGENT_ICON_NAME_SET.has(value);
}

/** The manifest `icon` of a Lucide icon picked for an agent: `lucide:<name>`. */
export function agentIconRef(name: AgentIconName): string {
  return `${LUCIDE_ICON_PREFIX}${name}`;
}

export function isAgentColorKey(value: string | null | undefined): value is AgentColorKey {
  return Boolean(value && value in AGENT_COLOR_CATALOG);
}

function isAgentCustomColor(value: string | null | undefined): value is `#${string}` {
  return Boolean(value && /^#[0-9a-f]{6}$/i.test(value));
}

/**
 * An agent's tile: its manifest `icon` when a surface can draw it (a Lucide
 * name this bundle knows, another Iconify id, an image URL), `lucide:bot`
 * otherwise; its colour key or `#rrggbb`, neutral otherwise.
 */
export function resolveAgentIdentity(icon?: string | null, color?: string | null) {
  const parsed = parseManifestIcon(icon);
  const resolvedIcon =
    parsed && (parsed.kind !== "lucide" || isLucideIconName(parsed.name))
      ? parsed
      : DEFAULT_AGENT_ICON;
  const resolvedColor = isAgentColorKey(color)
    ? color
    : isAgentCustomColor(color)
      ? color.toLowerCase()
      : "neutral";
  const customColor = isAgentCustomColor(resolvedColor) ? resolvedColor : undefined;
  const tintClassName = isAgentColorKey(resolvedColor)
    ? AGENT_COLOR_CATALOG[resolvedColor]
    : undefined;

  return {
    icon: resolvedIcon,
    color: resolvedColor,
    customColor,
    tintClassName,
  };
}
