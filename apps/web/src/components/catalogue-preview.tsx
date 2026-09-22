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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import type { LibraryPackageItem, LibrarySpace } from "../hooks/use-library";
import { packageDetailPath } from "../lib/package-paths";
import { useOrg } from "../hooks/use-org";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

export function CataloguePreview({
  item,
  type,
  spaces,
  isActivating,
  targets,
  defaultTarget,
  onAdd,
  onBack,
}: {
  item: LibraryPackageItem;
  type: PackageType;
  spaces: LibrarySpace[];
  isActivating: boolean;
  /**
   * The spaces this package could be added to BY THIS CALLER: not already
   * running it, and granting them the activation there. Empty when there is
   * nowhere left — a system agent is readable everywhere, and a package on in
   * every reachable space has no target.
   */
  targets: { id: string; name: string }[];
  /** The space to propose first: the one the reader narrowed to, or stands in. */
  defaultTarget: string | null;
  /** Goes through the catalogue's own activation, which asks about integrations first. */
  onAdd: (spaceId: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { currentOrg } = useOrg();
  const [target, setTarget] = useState<string>(
    defaultTarget && targets.some((space) => space.id === defaultTarget)
      ? defaultTarget
      : (targets[0]?.id ?? ""),
  );
  const home = spaces.find((space) => space.id === item.home_space_id);
  // Placed AND switched on: a placement that exists but is off does not run
  // here, and this line answers "where does it run".
  const installedIn = spaces.filter((space) =>
    item.placements.some(
      (placement) => placement.space_id === space.id && placement.state === "active",
    ),
  );

  return (
    <div>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2 gap-1.5" onClick={onBack}>
        <ArrowLeft />
        {t("catalogue.back")}
      </Button>

      <div className="flex min-h-9 items-start justify-between gap-4">
        <SettingsHeading className="mb-0" title={item.name || item.id} />
        {/* Adding is done HERE, on the sheet, and says which space: it is a
            considered act — the space, and what the package needs there — not
            a switch in a grid of empty ones. With one possible space the
            choice is shown, not asked. */}
        {targets.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            {targets.length > 1 ? (
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="h-9 w-44" aria-label={t("catalogue.addTarget")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button type="button" disabled={isActivating || !target} onClick={() => onAdd(target)}>
              {isActivating && <Spinner />}
              {targets.length > 1
                ? t("catalogue.add")
                : t("catalogue.addTo", { space: targets[0]!.name })}
            </Button>
          </div>
        )}
      </div>

      {item.description && <p className="text-muted-foreground mt-2 text-sm">{item.description}</p>}

      <dl className="mt-6 space-y-4 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {t("catalogue.origin")}
          </dt>
          <dd className="mt-1 flex items-center gap-1.5">
            {item.source === "system" ? (
              <>
                <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
                {t("catalogue.sourceSystem")}
              </>
            ) : (
              t("catalogue.sourceOrg", { name: currentOrg?.name ?? "" })
            )}
          </dd>
        </div>
        {home && (
          <div>
            <dt className="text-muted-foreground text-xs tracking-wide uppercase">
              {t("catalogue.homeSpace")}
            </dt>
            {/* Where the package lives, which is where it is edited (#1437). */}
            <dd className="mt-1">{home.name}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">
            {t("catalogue.activeIn")}
          </dt>
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
