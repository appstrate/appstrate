import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import type { LucideIcon } from "lucide-react";

export function LoadingState() {
  return (
    <div className="empty-state">
      <Spinner />
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div className="empty-state">
      <p>{t("error.generic")}</p>
      {message && <p className="empty-hint">{message}</p>}
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
  hint?: string;
  compact?: boolean;
  icon?: LucideIcon;
  children?: React.ReactNode;
}) {
  return (
    <div className={`empty-state${compact ? " empty-state-compact" : ""}`}>
      {Icon && <Icon className="empty-state-icon" />}
      {compact ? (
        <>
          <p className="empty-hint">{message}</p>
          {hint && <p className="empty-hint">{hint}</p>}
        </>
      ) : (
        <>
          <p>{message}</p>
          {hint && <p className="empty-hint">{hint}</p>}
        </>
      )}
      {children && <div className="empty-state-actions">{children}</div>}
    </div>
  );
}
