// SPDX-License-Identifier: Apache-2.0

import { cloneElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { FieldDescription, FieldError } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";

interface ControlProps {
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/**
 * A labelled control with its hint and error wired by id: the label targets
 * the control, `aria-describedby` points at whichever of hint/error is shown.
 */
export function FormItem({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** The message to show; nothing when the field is valid. */
  error?: ReactNode;
  className?: string;
  children: ReactElement;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div data-slot="form-item" className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children as ReactElement<ControlProps>, {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
