// SPDX-License-Identifier: Apache-2.0

/**
 * One label/value fact of a run. Shared by the Exécution and Configuration
 * panes — the split moved the facts apart but not the way they are drawn, and
 * two copies of a five-line card is how the two panes start drifting.
 */
export function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border bg-muted/30 rounded-lg border p-4">
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
