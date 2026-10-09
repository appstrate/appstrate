// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { cn } from "@appstrate/ui/cn";

/** Click-to-rename label. `onSave` calls `onSuccess` once saved: a refused label stays open to fix. */
export function InlineLabelEditor({
  current,
  saving,
  onSave,
  editTitle,
  placeholder,
  className,
  iconClassName,
  inputClassName,
}: {
  current: string;
  saving: boolean;
  onSave: (next: string, onSuccess: () => void) => void;
  editTitle: string;
  placeholder: string;
  /** Text styling of the label button. */
  className?: string;
  /** Pencil colour; inherits the button's when absent. */
  iconClassName?: string;
  /** Input width. */
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(current);
          setEditing(true);
        }}
        className={cn("inline-flex items-center gap-1.5", className)}
        title={editTitle}
      >
        <span>{current}</span>
        <Pencil className={cn("h-3 w-3", iconClassName)} />
      </button>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === current) setEditing(false);
    else onSave(trimmed, () => setEditing(false));
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className={cn("h-7 text-xs", inputClassName)}
        disabled={saving}
        placeholder={placeholder}
      />
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={commit} disabled={saving}>
        <Check className="h-3 w-3" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        onClick={() => setEditing(false)}
        disabled={saving}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
