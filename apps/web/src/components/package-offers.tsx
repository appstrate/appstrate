// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  useSpaceLibrary,
  useTogglePackageInstall,
  type LibraryOffer,
  type LibrarySpace,
} from "../hooks/use-library";
import { useSpaces } from "../hooks/use-spaces";
import { useSpaceSwitcher } from "../hooks/use-current-space";
import { packageDetailPath } from "../lib/package-paths";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
import { ErrorState } from "./page-states";

/** Pending offers belong next to the packages in the current space. */
export function SpacePackageOffers({ type }: { type: PackageType }) {
  const { data, error } = useSpaceLibrary();
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!data) return null;
  return (
    <SharedWithMe
      shared={data.shared.filter((offer) => offer.type === type)}
      spaces={data.spaces}
    />
  );
}

/**
 * The offers still waiting on a decision (RBAC spec §6.10). A share makes a
 * package READABLE; it never installs it, because it would run with the
 * recipient's own credentials — so accepting is a button the recipient presses.
 *
 * There is ONE act and one route behind both buttons — `POST
 * /api/spaces/{spaceId}/packages`, the single door. Only the wording and who
 * may press differ: an offer to the caller's OWN personal space needs no grant
 * at all (owning the space is the authorization), while an offer to a TEAM
 * space is shown only to a caller holding the type's install grant THERE —
 * without a button of its own the row said "offered in « T »" and left the
 * reader to find the package in the matrix below, having been told it was
 * shared with them.
 */
export function SharedWithMe({
  shared,
  spaces,
}: {
  shared: LibraryOffer[];
  spaces: LibrarySpace[];
}) {
  const { t } = useTranslation();
  const { switchSpace } = useSpaceSwitcher();
  const install = useTogglePackageInstall();
  const { data: accessibleSpaces } = useSpaces();
  if (shared.length === 0) return null;
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  /** The install grant in the OFFERED space — the target of this row's button. */
  const canInstallThere = (spaceId: string, type: string) =>
    accessibleSpaces
      ?.find((space) => space.id === spaceId)
      ?.permissions.includes(PACKAGE_PERMISSIONS[type as PackageType].install) ?? false;

  return (
    <div className="mb-6 rounded-lg border p-4">
      <h2 className="text-sm font-medium">{t("library.shared.title")}</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">{t("library.shared.hint")}</p>
      <ul className="mt-3 divide-y">
        {shared.map((offer) => (
          <li
            key={`${offer.id}:${offer.space_id}`}
            className="flex flex-wrap items-center gap-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <Link
                to={packageDetailPath(offer.type, offer.id)}
                onClick={() => switchSpace(offer.space_id)}
                className="text-sm font-medium hover:underline"
              >
                {offer.name}
              </Link>
              <Badge variant="outline" className="ml-2">
                {t("library.shared.pending")}
              </Badge>
              <p className="text-muted-foreground truncate text-xs">
                {offer.personal
                  ? offer.shared_by
                    ? t("library.shared.by", { name: offer.shared_by.name })
                    : offer.description
                  : t("library.shared.inSpace", { space: spaceName(offer.space_id) })}
              </p>
            </div>
            {offer.personal ? (
              <Button
                size="sm"
                disabled={install.isPending}
                onClick={() =>
                  install.mutate(
                    { spaceId: offer.space_id, packageId: offer.id, installed: false },
                    {
                      onSuccess: () => toast.success(t("library.shared.added")),
                      onError: (err) => toast.error(getErrorMessage(err)),
                    },
                  )
                }
              >
                {t("library.shared.add")}
              </Button>
            ) : (
              canInstallThere(offer.space_id, offer.type) && (
                <Button
                  size="sm"
                  disabled={install.isPending}
                  onClick={() =>
                    install.mutate(
                      { spaceId: offer.space_id, packageId: offer.id, installed: false },
                      {
                        onSuccess: () =>
                          toast.success(
                            t("library.shared.installed", { space: spaceName(offer.space_id) }),
                          ),
                        onError: (err) => toast.error(getErrorMessage(err)),
                      },
                    )
                  }
                >
                  {t("library.shared.installIn", { space: spaceName(offer.space_id) })}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
