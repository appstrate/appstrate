import { Spinner } from "./spinner";

export function LoadingState() {
  return (
    <div className="empty-state">
      <Spinner />
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  return (
    <div className="empty-state">
      <p>Une erreur est survenue.</p>
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
