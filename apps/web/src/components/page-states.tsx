// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import { SearchX, type LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { errorDetail } from "../lib/mutation-error";
import { ApiError } from "../api/errors";

export function LoadingState() {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

/** `error` is shown as its translated refusal; `message` is a line the caller already wrote. */
export function ErrorState({ message, error }: { message?: string; error?: unknown }) {
  const { t } = useTranslation();
  const detail = message ?? errorDetail(error);
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
      <p>{t("error.generic")}</p>
      {detail && <p className="mt-1 text-sm">{detail}</p>}
    </div>
  );
}

/**
 * A detail page's unreadable resource: missing and forbidden get the same panel, as the API
 * answers them alike. `hint` and `children` are the page's own way forward for that panel
 * (what to ask for, where to go); any other failure shows neither.
 */
export function ResourceErrorState({
  error,
  hint,
  children,
}: {
  error: unknown;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return (
      <EmptyState
        icon={SearchX}
        message={t("error.resourceUnavailable")}
        hint={hint ?? t("error.resourceUnavailableHint")}
      >
        {children}
      </EmptyState>
    );
  }
  return <ErrorState error={error} />;
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
