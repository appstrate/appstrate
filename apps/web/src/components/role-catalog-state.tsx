// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@appstrate/core/errors";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";

/**
 * What a role catalog (`useSpaceRoleOptions`) says when it has no usable list:
 * still loading, failed with a retry, or loaded and offering nothing.
 *
 * `rolesKnown` is separate from `isLoading` because an unknown catalog is not
 * an empty one — a refetch that has not landed must not read as "no role can be
 * granted here". What counts as empty differs per picker (the roles it offers,
 * or the spaces they are offered for), so callers pass the message to show and
 * `null` when there is nothing to report.
 */
export function RoleCatalogState({
  isLoading,
  rolesKnown = true,
  error,
  refetch,
  loadingMessage,
  emptyMessage,
  className,
}: {
  isLoading: boolean;
  rolesKnown?: boolean;
  error: unknown;
  refetch: () => void;
  loadingMessage?: string;
  emptyMessage: string | null;
  className?: string;
}) {
  const { t } = useTranslation(["settings", "common"]);

  if (error)
    return (
      <Alert variant="destructive" className={className}>
        <AlertDescription>
          <p>{getErrorMessage(error)}</p>
          <Button type="button" variant="outline" size="sm" onClick={refetch}>
            {t("btn.retry", { ns: "common" })}
          </Button>
        </AlertDescription>
      </Alert>
    );

  if (isLoading || !rolesKnown)
    return (
      <p role="status" className={cn("text-muted-foreground text-sm", className)}>
        {loadingMessage ?? t("spaceMembers.rolesLoading")}
      </p>
    );

  if (emptyMessage)
    return <p className={cn("text-muted-foreground text-sm", className)}>{emptyMessage}</p>;

  return null;
}
