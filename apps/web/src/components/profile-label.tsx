// SPDX-License-Identifier: Apache-2.0

import { User, Building2 } from "lucide-react";

interface ActorLabelProps {
  actorType: "user" | "end_user" | null;
  actorName: string | null;
  iconSize?: string;
  className?: string;
}

/**
 * Renders the actor (member or end-user) a schedule runs as. Replaces the
 * former connection-profile label after the profiles feature was removed.
 */
export function ProfileLabel({
  actorType,
  actorName,
  iconSize = "size-3",
  className,
}: ActorLabelProps) {
  if (!actorName) return null;

  const Icon = actorType === "end_user" ? Building2 : User;

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <Icon className={iconSize} />
      {actorName}
    </span>
  );
}
