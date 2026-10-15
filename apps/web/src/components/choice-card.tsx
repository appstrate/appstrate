// SPDX-License-Identifier: Apache-2.0

import type { ComponentType, ReactNode } from "react";
import { Button } from "@appstrate/ui/components/button";

/** A full-width option button: icon tile, title (with an optional trailing adornment), description. */
export function ChoiceCard({
  icon: Icon,
  title,
  description,
  adornment,
  onClick,
  disabled,
  ...data
}: {
  icon: ComponentType;
  title: ReactNode;
  description: ReactNode;
  /** Rendered after the title, e.g. a badge or a copy glyph. */
  adornment?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** `data-*` hooks the lab's drivers read. */
  [key: `data-${string}`]: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
      onClick={onClick}
      disabled={disabled}
      {...data}
    >
      <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
        <Icon />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {adornment}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
          {description}
        </span>
      </span>
    </Button>
  );
}
