// SPDX-License-Identifier: Apache-2.0

import { ToneAlert } from "@/components/app-ui/status-variants";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import type { PackageType } from "@appstrate/core/validation";
import { packageDetailPath } from "../../lib/package-paths";

/**
 * What the reader needs to know about whose package this is: a system package is
 * read-only (duplicate it to customise), a fork names its origin, and a draft
 * the reader cannot write is somebody's work in progress. An agent says nothing
 * about being read-only — its header marks a system agent, and it can be run.
 */
export function PackageOwnershipNotice({
  type,
  isOwned,
  forkedFrom,
  draftReadOnly,
}: {
  type: PackageType;
  isOwned: boolean;
  forkedFrom: string | null;
  /** Nothing is published and the working copy is not this reader's. */
  draftReadOnly: boolean;
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

  return (
    <>
      {draftReadOnly && (
        <Alert className="mb-4">
          <AlertDescription>{t("detail.draftReadOnly")}</AlertDescription>
        </Alert>
      )}
      {!isOwned && type !== "agent" && (
        <ToneAlert variant="info" className="mb-4">
          <Info />
          <AlertDescription className="flex flex-wrap items-center gap-x-3">
            <span>{t("ownership.readOnly")}</span>
            {origin}
          </AlertDescription>
        </ToneAlert>
      )}
      {isOwned && origin && (
        <div className="border-border/50 bg-muted/30 mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
          {origin}
        </div>
      )}
    </>
  );
}
