// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Button } from "@appstrate/ui/components/button";
import { commitRename } from "../lib/inline-rename";

/**
 * A table row's name, renamed in place — the app's ONE rename affordance. It opens only
 * when the row's « Renommer » entry sets `editing` (no click-to-edit, no hover pencil).
 * Raised above the row's cover in both states, so its `title` reads and the field takes
 * clicks. Saves on explicit confirmation or Enter, cancels on Escape, and fires `onSave` only when the
 * trimmed value changed. It truncates: a long name must not eat the column's floor.
 */
export function InlineEditableLabel({
  value,
  editable,
  onSave,
  placeholder,
  testId,
  editing,
  onEditingChange,
}: {
  value: string;
  editable: boolean;
  onSave: (newValue: string) => void | Promise<void>;
  placeholder?: string;
  testId?: string;
  /** Edit mode, driven by the row: its « Renommer » menu entry sets it. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t } = useTranslation("common");
  // `null` reads the stored value, so an edit started from outside never opens on a stale draft.
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? value;
  const setEditing = (next: boolean) => {
    if (!next) setTyped(null);
    onEditingChange(next);
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Entering edit mode, from the menu, lands in the field with its text selected.
  useEffect(() => {
    if (editable && editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editable, editing]);

  const commit = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const outcome = await commitRename(draft, value, onSave);
    savingRef.current = false;
    setSaving(false);
    // A failed write keeps edit mode and the draft, so a commit on blur erases nothing.
    if (outcome !== "failed") setEditing(false);
  };

  if (!editable || !editing) {
    return (
      <span
        className="relative z-10 block w-fit max-w-full min-w-0 truncate text-sm font-medium"
        title={value}
        data-testid={testId}
      >
        {value}
      </span>
    );
  }

  return (
    <div className="relative z-10 flex min-w-0 items-center gap-1" aria-busy={saving}>
      <Input
        ref={inputRef}
        // Read by the dialogs: Escape here cancels the rename, not the overlay.
        data-inline-editing=""
        // The field has no visible label: it is named by the name it renames.
        aria-label={t("renameField", { name: value })}
        value={draft}
        disabled={saving}
        placeholder={placeholder}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape" && !savingRef.current) setEditing(false);
        }}
        // `min-w-0`, not `min-w-40`: in a 132px column a 10rem minimum is an
        // input wider than the cell that holds it.
        className="h-7 w-full min-w-0 text-sm font-medium"
        data-testid={testId}
      />
      <Button type="button" size="sm" disabled={saving} onClick={() => void commit()}>
        {t("btn.save")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        {t("btn.cancel")}
      </Button>
    </div>
  );
}
