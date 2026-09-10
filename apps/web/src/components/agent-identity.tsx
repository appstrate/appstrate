// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";
import { DynamicIcon } from "lucide-react/dynamic";
import { resolveAgentIdentity } from "./agent-identity-options";

export function AgentIdentityTile({
  agentId,
  icon,
  color,
  className,
  iconClassName,
}: {
  agentId: string;
  icon?: string | null;
  color?: string | null;
  className?: string;
  iconClassName?: string;
}) {
  const { icon: resolvedIcon, customColor, tintClassName } = resolveAgentIdentity(icon, color);

  return (
    <span
      data-agent-id={agentId}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg",
        tintClassName,
        className,
      )}
      style={customColor ? { backgroundColor: `${customColor}1f`, color: customColor } : undefined}
      aria-hidden="true"
    >
      <DynamicIcon
        name={resolvedIcon}
        className={cn("size-[18px]", iconClassName)}
        strokeWidth={1.8}
      />
    </span>
  );
}
