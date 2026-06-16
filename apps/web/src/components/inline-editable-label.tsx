// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Input } from "@appstrate/ui/components/input";
import { cn } from "@/lib/utils";

/**
 * A label that turns into an inline text input on click (when editable). Saves
 * on blur or Enter, cancels on Escape, and only fires `onSave` when the trimmed
 * value actually changed. Shared by the credential and (future) other settings
 * tables so the rename affordance stays identical.
 */
export function InlineEditableLabel({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editable || !editing) {
    return (
      <span
        className={cn("text-sm font-medium", editable && "cursor-pointer hover:underline")}
        onClick={() => {
          if (editable) {
            setDraft(value);
            setEditing(true);
          }
        }}
      >
        {value}
      </span>
    );
  }

  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
      }}
      className="h-7 w-auto min-w-40 text-sm font-medium"
    />
  );
}
