// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../cn.ts";
import { Label } from "./label.tsx";

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn("flex w-full flex-col gap-3", className)}
      {...props}
    />
  );
}

const fieldVariants = cva("group/field flex w-full gap-3", {
  variants: {
    orientation: {
      vertical: "flex-col [&>*]:w-full",
      horizontal: "flex-row items-center",
    },
  },
  defaultVariants: {
    orientation: "vertical",
  },
});

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm leading-snug font-medium group-data-[disabled=true]/field:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-muted-foreground text-xs leading-normal font-normal", className)}
      {...props}
    />
  );
}

/** A field's refusal, announced when it appears. Renders nothing without a message. */
function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  if (!children) return null;
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn("text-destructive text-sm", className)}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * One labelled control: label, the control, then its hint and its refusal.
 * The single child receives `id`, `aria-invalid` and `aria-describedby`, so a
 * caller never wires them by hand.
 */
function FormItem({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** The message to show; nothing when the field is valid. */
  error?: React.ReactNode;
  className?: string;
  children: React.ReactElement;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div data-slot="form-item" className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Slot id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
        {children}
      </Slot>
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldTitle, FormItem };
