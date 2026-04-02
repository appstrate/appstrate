// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
