// SPDX-License-Identifier: Apache-2.0

/** The bordered list of integrations a closure dialog names, each with an optional note on its right. */
export function ClosureList({
  entries,
}: {
  entries: readonly { id: string; name: string; note?: string }[];
}) {
  return (
    <ul className="border-border divide-border divide-y rounded-lg border">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="truncate">{entry.name}</span>
          {entry.note && (
            <span className="text-muted-foreground shrink-0 text-xs">{entry.note}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
