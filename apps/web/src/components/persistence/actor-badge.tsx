// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { PersistenceActorType } from "@appstrate/shared-types";

/**
 * Tiny capsule that shows whether a persistence row is `shared` (app-wide)
 * or scoped to the caller's actor. The Agent-level Checkpoints tab also
 * passes `actorId` so admins can disambiguate between actors of the same
 * type.
 */
export function ActorBadge({
  actorType,
  actorId,
}: {
  actorType: PersistenceActorType;
  actorId?: string | null;
}) {
  const { t } = useTranslation("agents");
  const isShared = actorType === "shared";
  return (
    <span
      className={
        isShared
          ? "bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
          : "bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
      }
      title={actorId ?? undefined}
    >
      {isShared ? t("detail.memoryScopeBadgeShared") : t("detail.memoryScopeBadgeMine")}
    </span>
  );
}
