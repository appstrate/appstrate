import { ProviderIcon } from "./provider-icon";

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
    <div className="border-border bg-card rounded-lg border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {iconUrl && <ProviderIcon src={iconUrl} className="h-5 w-5" />}
          <span className="text-foreground truncate text-sm font-medium">{displayName}</span>
        </div>
        {badges && <div className="flex shrink-0 items-center gap-1.5">{badges}</div>}
      </div>
      {description && (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{description}</p>
      )}
      {actions && (
        <div className="border-border mt-3 flex items-center gap-2 border-t pt-3">
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      )}
    </div>
  );
}
