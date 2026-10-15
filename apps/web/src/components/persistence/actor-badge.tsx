// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { PersistenceActorType } from "@appstrate/shared-types";

/** Capsule showing whether a persistence row is `shared` or actor-scoped; `actor_id` disambiguates actors of one type. */
export function ActorBadge({
  actor_type,
  actor_id,
}: {
  actor_type: PersistenceActorType;
  actor_id?: string | null;
}) {
  const { t } = useTranslation("agents");
  const isShared = actor_type === "shared";
  return (
    <span
      className={
        isShared
          ? "bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
          : "bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
      }
      title={actor_id ?? undefined}
    >
      {isShared ? t("detail.memoryScopeBadgeShared") : t("detail.memoryScopeBadgeMine")}
    </span>
  );
}
