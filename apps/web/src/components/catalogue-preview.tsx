// SPDX-License-Identifier: Apache-2.0

/**
 * One package, read inside the catalogue rather than instead of it.
 *
 * A row used to link to the package's own page, which threw away the panel,
 * the space you were in and the list you were reading — and landed on a page
 * whose breadcrumb claims the current space for a package that is not in it.
 * This reads in place: the rail stays, Back comes straight back.
 *
 * What it shows is what the library knows, which is exactly the question a
 * catalogue answers: what this is, where it comes from, and which spaces
 * already run it. Everything else — runs, versions, files, settings — belongs
 * to the package's page, one link away, and most of it says nothing at all
 * about a package this space has not activated yet.
 */
import { useTranslation } from "react-i18next";
import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import type { LibraryPackageItem, LibrarySpace } from "../hooks/use-library";
import { packageDetailPath } from "../lib/package-paths";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

export function CataloguePreview({
  item,
  type,
  spaces,
  isActivating,
  onActivate,
  onBack,
}: {
  item: LibraryPackageItem;
  type: PackageType;
  spaces: LibrarySpace[];
  isActivating: boolean;
  onActivate: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const installedIn = spaces.filter((space) => item.installed_in.includes(space.id));

  return (
    <div>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2 gap-1.5" onClick={onBack}>
        <ArrowLeft />
        {t("catalogue.back")}
      </Button>

      <div className="flex min-h-9 items-start justify-between gap-4">
        <SettingsHeading className="mb-0" title={item.name || item.id} />
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" disabled={isActivating} onClick={onActivate}>
            {isActivating && <Spinner />}
            {t("catalogue.activate")}
          </Button>
        </div>
      </div>

      {item.description && <p className="text-muted-foreground mt-2 text-sm">{item.description}</p>}

      <dl className="mt-6 space-y-4 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {t("list.column.source", { ns: "agents" })}
          </dt>
          <dd className="mt-1 flex items-center gap-1.5">
            {item.source === "system" ? (
              <>
                <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
                {t("list.badgeBuiltIn", { ns: "agents" })}
              </>
            ) : (
              t("catalogue.originOrg")
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {t("catalogue.activeIn")}
          </dt>
          {/* The honest answer to "which space is this package's home": there is
              no single one, so the panel names them all rather than picking. */}
          <dd className="mt-1">
            {installedIn.length > 0
              ? installedIn.map((space) => space.name).join(" · ")
              : t("catalogue.activeNowhere")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {t("catalogue.identifier")}
          </dt>
          <dd className="mt-1 font-mono text-xs break-all">{item.id}</dd>
        </div>
      </dl>

      <Link
        to={packageDetailPath(type, item.id)}
        className="text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
      >
        <ExternalLink className="size-3.5" />
        {t("catalogue.openFullPage")}
      </Link>
    </div>
  );
}
