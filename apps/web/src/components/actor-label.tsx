// SPDX-License-Identifier: Apache-2.0

import { User, Building2 } from "lucide-react";

interface ActorLabelProps {
  actor_type: "user" | "end_user" | null;
  actor_name: string | null;
  iconSize?: string;
  className?: string;
}

/**
 * Renders the actor (member or end-user) a schedule runs as.
 */
export function ActorLabel({
  actor_type,
  actor_name,
  iconSize = "size-3",
  className,
}: ActorLabelProps) {
  if (!actor_name) return null;

  const Icon = actor_type === "end_user" ? Building2 : User;

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <Icon className={iconSize} />
      {actor_name}
    </span>
  );
}
