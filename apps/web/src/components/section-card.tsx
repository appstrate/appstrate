// SPDX-License-Identifier: Apache-2.0

interface SectionCardProps {
  title: string;
  /** Extra content rendered inline in the header (e.g. an upload button). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

export function SectionCard({ title, headerRight, children }: SectionCardProps) {
  return (
    <div className="border-border bg-card mb-4 overflow-hidden rounded-lg border">
      <div className="bg-background text-foreground border-border flex items-center justify-between border-b px-4 py-3 text-xs font-semibold tracking-wide uppercase">
        {title}
        {headerRight}
      </div>
      <div className="space-y-3 p-4">{children}</div>
    </div>
  );
}
