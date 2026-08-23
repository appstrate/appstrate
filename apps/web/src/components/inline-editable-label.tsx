// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "./spinner";

/**
 * A label that turns into an inline text input on click (when editable). Saves
 * on blur or Enter, cancels on Escape, and only fires `onSave` when the trimmed
 * value actually changed.
 *
 * **This is the app's ONE rename affordance**, and the reason it is one is a
 * product decision: "Direct manipulation in forms. No Edit button revealing a
 * field." A pencil that swaps a label for an input puts a click and a mode
 * change between someone and a one-word edit, and the app had both patterns
 * side by side — this on the credentials table, a pencil on the integration
 * connections.
 *
 * Two things it had to grow before the second caller could take it:
 *
 * - **It truncates.** It sits in a table cell whose column has a floor, and a
 *   long account name that refuses to shrink eats the column — which is
 *   exactly how the connections table lost the name it was naming rows with.
 * - **It can be CLEARED** (`allowEmpty`), because a connection's label falls
 *   back to its account id when null, so emptying the field is a real
 *   operation there. A credential has no such fallback, which is why clearing
 *   stays opt-in rather than becoming the rule.
 */
export function InlineEditableLabel({
  value,
  editable,
  onSave,
  allowEmpty = false,
  placeholder,
  testId,
}: {
  value: string;
  editable: boolean;
  onSave: (newValue: string) => void | Promise<void>;
  /** Emptying the field is meaningful — the caller has a fallback to fall to. */
  allowEmpty?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const { t } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const commit = async () => {
    if (savingRef.current) return;
    const next = draft.trim();
    // `allowEmpty` is what makes clearing a real answer rather than a no-op.
    if (next === value || (!allowEmpty && !next)) {
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
        className={cn(
          "block truncate text-sm font-medium",
          editable && "cursor-pointer hover:underline",
        )}
        title={value}
        onClick={() => {
          if (editable) {
            setDraft(value);
            setEditing(true);
          }
        }}
        data-testid={testId}
      >
        {value}
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1" aria-busy={saving}>
      <Input
        autoFocus
        value={draft}
        disabled={saving}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
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
