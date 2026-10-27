// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import type { PackageType } from "@appstrate/core/validation";
import { packageDetailPath } from "../../lib/package-paths";

/** Whose package this is: system (read-only), a fork's origin, or someone else's draft. An agent never says read-only; its header marks system agents. */
export function PackageOwnershipNotice({
  type,
  isOwned,
  forkedFrom,
  draftReadOnly,
  pending = false,
}: {
  type: PackageType;
  isOwned: boolean;
  forkedFrom: string | null;
  /** Nothing is published and the working copy is not this reader's. */
  draftReadOnly: boolean;
  /** The package detail (source, origin, draft) is still on its way: the notice's place is held, not left to pop in. */
  pending?: boolean;
}) {
  const { t } = useTranslation("agents");
  const origin = forkedFrom && (
    <span className="text-muted-foreground">
      {t("ownership.forkedFrom")}
      <Link to={packageDetailPath(type, forkedFrom)} className="text-primary hover:underline">
        {forkedFrom}
      </Link>
    </span>
  );

  if (pending) return <Skeleton className="mb-4 h-12 w-full rounded-lg" />;

  return (
    <>
      {draftReadOnly && (
        <Alert className="mb-4">
          <AlertDescription>{t("detail.draftReadOnly")}</AlertDescription>
        </Alert>
      )}
      {!isOwned && type !== "agent" && (
        <Alert variant="info" className="mb-4">
          <Info />
          <AlertDescription className="flex flex-wrap items-center gap-x-3">
            <span>{t("ownership.readOnly")}</span>
            {origin}
          </AlertDescription>
        </Alert>
      )}
      {isOwned && origin && (
        <div className="border-border/50 bg-muted/30 mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
          {origin}
        </div>
      )}
    </>
  );
}
