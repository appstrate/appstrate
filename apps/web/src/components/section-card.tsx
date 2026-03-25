interface SectionCardProps {
  title: string;
  /** Extra content rendered inline in the header (e.g. an upload button). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

export function SectionCard({ title, headerRight, children }: SectionCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
      <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border flex items-center justify-between">
        {title}
        {headerRight}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </div>
  );
}
