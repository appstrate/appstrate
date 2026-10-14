// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { AgentIdentityTile } from "./agent-identity";
import { IntegrationIcon } from "./integration-icon";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";

const BOX = { sm: "size-7 rounded-md", md: "size-10 rounded-[10px]" } as const;

/**
 * A package's identity tile, the same for every type and surface: an agent's
 * chosen icon and colour, an integration's logo (its placeholder when it has
 * none), the type's glyph on a muted ground for the rest.
 */
export function PackageIcon({
  type,
  id,
  icon,
  color,
  size = "md",
}: {
  type: PackageType;
  id: string;
  icon?: string | null;
  color?: string | null;
  size?: keyof typeof BOX;
}) {
  if (type === "agent") {
    return <AgentIdentityTile agentId={id} icon={icon} color={color} className={BOX[size]} />;
  }
  if (type === "integration") return <IntegrationIcon src={icon ?? undefined} size={size} />;
  const Glyph = PACKAGE_TYPE_ICON[type];
  return (
    <span
      className={cn(
        "bg-muted text-muted-foreground flex shrink-0 items-center justify-center",
        BOX[size],
      )}
      aria-hidden
    >
      <Glyph className={size === "sm" ? "size-4" : "size-5"} />
    </span>
  );
}
