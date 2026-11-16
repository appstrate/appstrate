// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";

/**
 * Where a package comes from and where it LIVES (which decides who may edit it), for the
 * detail header's meta line of every package type: facts, kept off a phone's one line.
 */
export function PackageOriginMeta({
  source,
  homeSpaceName,
}: {
  source: string;
  /** Absent for the org catalog and for a home the reader cannot enter. */
  homeSpaceName?: string | null;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  return (
    <>
      {source === "system" && (
        <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
          <span aria-hidden>·</span>
          <ShieldCheck className="size-3" aria-hidden />
          {t("list.badgeBuiltIn", { ns: "agents" })}
        </span>
      )}
      {homeSpaceName && (
        <span className="hidden shrink-0 items-center gap-1.5 md:inline-flex">
          <span aria-hidden>·</span>
          {t("packages.homeSpace", { ns: "settings", space: homeSpaceName })}
        </span>
      )}
    </>
  );
}
