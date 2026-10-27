// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";

/**
 * A labelled list of rows the user adds to and removes from. The caller draws a row's fields;
 * the editor owns the remove and add buttons.
 */
export function RowsEditor<T>({
  label,
  hint,
  rows,
  onChange,
  newRow,
  addLabel,
  minRows = 0,
  renderRow,
}: {
  label: string;
  hint?: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  /** The row « add » appends. */
  newRow: T;
  addLabel: string;
  /** Rows that cannot be removed: the remove button shows only above this count. */
  minRows?: number;
  /** `update` replaces this row; `index` is its position. */
  renderRow: (row: T, update: (next: T) => void, index: number) => ReactNode;
}) {
  const { t } = useTranslation("common");

  return (
    <div className="flex flex-col gap-2">
      <Label className="mb-0">{label}</Label>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          {renderRow(row, (next) => onChange(rows.map((r, i) => (i === index ? next : r))), index)}
          {rows.length > minRows && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("btn.delete")}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, newRow])}
      >
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
