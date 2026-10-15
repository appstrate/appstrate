// SPDX-License-Identifier: Apache-2.0

/**
 * How a collection is drawn — table or cards on the level-one lists, list or
 * matrix on the roles page. A grey track with a white chip on the chosen one,
 * the same segmented control the shell uses for its products, and no colour:
 * a blue fill here read as a state rather than a choice.
 *
 * It changes the DRAWING, never the content, which is why it is not a tab.
 */
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

export function ViewToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ id: T; icon: LucideIcon; label: string }>;
}) {
  return (
    <div className="bg-accent inline-flex shrink-0 gap-0.5 rounded-md p-0.5">
      {options.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-label={label}
          aria-pressed={value === id}
          className={cn(
            "grid size-7 place-items-center rounded-sm p-0 transition-colors",
            value === id
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
