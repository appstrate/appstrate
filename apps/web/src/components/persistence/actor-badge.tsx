// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { authStore } from "../../stores/auth-store";
import { memoryScopeOf } from "../../lib/memory-items";

/** Capsule showing whether a persistence row is `shared`, the signed-in user's, or another actor's (`actor_id` in the title). */
export function ActorBadge({
  actor_type,
  actor_id,
}: {
  actor_type: PersistenceActorType;
  actor_id?: string | null;
}) {
  const { t } = useTranslation("agents");
  const userId = useStore(authStore, (s) => s.user?.id);
  const scope = memoryScopeOf({ actor_type, actor_id: actor_id ?? null }, userId);
  const isShared = scope === "shared";
  return (
    <span
      className={
        isShared
          ? "bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
          : "bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
      }
      title={actor_id ?? undefined}
    >
      {isShared
        ? t("detail.memoryScopeBadgeShared")
        : scope === "mine"
          ? t("detail.memoryScopeBadgeMine")
          : t("detail.memoryScopeBadgeOthers")}
    </span>
  );
}
