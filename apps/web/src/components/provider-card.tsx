interface ProviderCardProps {
  displayName: string;
  description?: string | null;
  iconUrl?: string;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
}

export function ProviderCard({
  displayName,
  description,
  iconUrl,
  badges,
  actions,
}: ProviderCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {iconUrl && (
            <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 rounded object-contain" />
          )}
          <span className="text-sm font-medium text-foreground truncate">{displayName}</span>
        </div>
        {badges && <div className="flex items-center gap-1.5 shrink-0">{badges}</div>}
      </div>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{description}</p>
      )}
      {actions && (
        <div className="mt-3 pt-3 border-t border-border flex items-center gap-2">
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      )}
    </div>
  );
}
