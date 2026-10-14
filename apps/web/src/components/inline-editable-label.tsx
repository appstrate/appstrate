// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Spinner } from "./spinner";

/**
 * A table row's name, renamed in place. **It opens only when something drives it**: the row's
 * « Renommer » entry sets `editing`, and a click on the name does not edit it, nor does a pencil
 * appear on hover (both made noise in a table whose « … » menu already holds the rename). Out of
 * edit it is the row's text: raised above the row's cover so its `title` reads, and a click on
 * it opens the row like a click anywhere else (`DataTable` hands it over). In edit it is raised
 * too, or the cover would take the field's clicks. Saves
 * on blur or Enter, cancels on Escape, and only fires `onSave` when the trimmed value actually
 * changed.
 *
 * **This is the app's ONE rename affordance**, and the reason it is one is a
 * product decision: "Direct manipulation in forms. No Edit button revealing a
 * field." The rename is the menu's, and the field appears in the name's place.
 *
 * **It truncates.** It sits in a table cell whose column has a floor, and a
 * long account name that refuses to shrink eats the column, and with it the
 * name the row is known by.
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
  // What was typed since the edit began; `null` reads the stored value, so an edit started from
  // outside never opens on a stale draft.
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
    const next = draft.trim();
    if (next === value || !next) {
      setEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // The caller owns the error message. Keeping edit mode and `draft` here
      // is what prevents a failed commit-on-blur write from erasing the input.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
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
        value={draft}
        disabled={saving}
        placeholder={placeholder}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape" && !savingRef.current) setEditing(false);
        }}
        // `min-w-0`, not `min-w-40`: in a 132px column a 10rem minimum is an
        // input wider than the cell that holds it.
        className="h-7 w-full min-w-0 text-sm font-medium"
        data-testid={testId}
      />
      {saving && <Spinner className="shrink-0" label={t("loading")} />}
    </div>
  );
}
