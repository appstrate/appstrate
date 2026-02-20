import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";

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
}: {
  message: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? " empty-state-compact" : ""}`}>
      {compact ? (
        <p className="empty-hint">{message}</p>
      ) : (
        <>
          <p>{message}</p>
          {hint && <p className="empty-hint">{hint}</p>}
        </>
      )}
    </div>
  );
}
