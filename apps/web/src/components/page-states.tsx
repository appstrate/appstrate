// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import { SearchX, type LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { errorMessage } from "../lib/mutation-error";
import { ApiError } from "../api/errors";

export function LoadingState() {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <p>{t("error.generic")}</p>
      {message && <p className="mt-1 text-sm">{message}</p>}
    </div>
  );
}

/**
 * A detail page whose resource could not be read. The API answers 404 for an id
 * that does not exist and for one the caller may not see alike (and 403 where
 * hiding it is pointless), so both get one panel that says so — never a silent
 * redirect, a blank page or the server's English `detail`.
 */
export function ResourceErrorState({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return (
      <EmptyState
        icon={SearchX}
        message={t("error.resourceUnavailable")}
        hint={t("error.resourceUnavailableHint")}
      />
    );
  }
  return <ErrorState message={error ? errorMessage(error) : undefined} />;
}

export function EmptyState({
  message,
  hint,
  compact,
  icon: Icon,
  children,
}: {
  message: string;
  hint?: React.ReactNode;
  compact?: boolean;
  icon: LucideIcon;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-col items-center justify-center",
        compact ? "py-8" : "py-16",
      )}
    >
      <Icon className="mb-3 h-10 w-10 opacity-40" />
      {compact ? (
        <>
          <p className="text-sm">{message}</p>
          {hint && <p className="mt-1 text-sm">{hint}</p>}
        </>
      ) : (
        <>
          <p>{message}</p>
          {hint && <p className="mt-1 text-sm">{hint}</p>}
        </>
      )}
      {children && <div className="mt-4 flex items-center gap-2">{children}</div>}
    </div>
  );
}
