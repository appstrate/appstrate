// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// RJSF templates built on this package's shadcn primitives. Only templates we
// actually want to restyle are overridden — RJSF defaults handle the rest.

import type {
  BaseInputTemplateProps,
  FieldTemplateProps,
  TitleFieldProps,
  DescriptionFieldProps,
  SubmitButtonProps,
  ArrayFieldTemplateProps,
  ArrayFieldItemTemplateProps,
  ObjectFieldTemplateProps,
  MultiSchemaFieldTemplateProps,
} from "@rjsf/utils";
import { getInputProps, getSubmitButtonOptions } from "@rjsf/utils";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "../cn.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Label } from "../components/label.tsx";
import type { SchemaFormContext } from "./context.ts";

export function BaseInputTemplate<T = unknown>(props: BaseInputTemplateProps<T>) {
  const {
    id,
    value,
    required,
    readonly,
    disabled,
    type,
    schema,
    onChange,
    onBlur,
    onFocus,
    options,
    autofocus,
    placeholder,
    rawErrors,
  } = props;

  const formatType =
    schema.format === "email"
      ? "email"
      : schema.format === "uri"
        ? "url"
        : schema.format === "date"
          ? "date"
          : schema.format === "date-time"
            ? "datetime-local"
            : schema.format === "time"
              ? "time"
              : "text";
  // Only the type is taken from RJSF: native `min` / `max` / `step` would raise
  // the browser's own bubble where the validator's message belongs.
  const inputType = getInputProps<T>(
    schema,
    type ?? (formatType === "text" ? undefined : formatType),
    options,
  ).type;
  const isNumeric = schema.type === "number" || schema.type === "integer";

  const isConst = schema && "const" in schema;
  const isReadOnly = readonly || isConst;

  return (
    <Input
      id={id}
      type={inputType}
      step={inputType === "number" ? "any" : undefined}
      // RJSF keeps a `number` as text under a comma-decimal locale.
      inputMode={isNumeric && inputType === "text" ? "decimal" : undefined}
      value={(value as string | number | undefined) ?? ""}
      required={required}
      readOnly={isReadOnly}
      disabled={disabled}
      autoFocus={autofocus && !isReadOnly}
      placeholder={(placeholder ?? (options?.["ui:placeholder"] as string | undefined)) as string}
      className={cn(
        // Form fields stay h-9 (the shadcn Input defaults to h-10).
        "h-9",
        isReadOnly && "bg-muted/50 cursor-not-allowed",
        rawErrors && rawErrors.length > 0 && "border-destructive",
      )}
      onChange={(e) =>
        onChange(
          e.target.value === "" ? (options?.emptyValue as T) : (e.target.value as unknown as T),
        )
      }
      onBlur={(e) => onBlur?.(id, e.target.value)}
      onFocus={(e) => onFocus?.(id, e.target.value)}
    />
  );
}

export function FieldTemplate(props: FieldTemplateProps) {
  const {
    id,
    label,
    children,
    rawErrors,
    rawDescription,
    required,
    displayLabel,
    hidden,
    schema,
    uiSchema,
    classNames,
  } = props;

  if (hidden) return <div className="hidden">{children}</div>;

  // File widget renders its own label so we skip the FieldTemplate label.
  const widget = (uiSchema as Record<string, unknown>)?.["ui:widget"];
  const isFileWidget = widget === "file";
  // Objects and arrays render labels via TitleField, so don't double up here —
  // unless a custom single-control widget (multi-select) is in play, in which
  // case we DO want the field-level label.
  const isSingleControlWidget = widget === "multiselect";
  const isContainer =
    !isSingleControlWidget && (schema.type === "object" || schema.type === "array");

  const showLabel = displayLabel && !isFileWidget && !isContainer && label;

  const showDescription = rawDescription && !isFileWidget && !isContainer;

  return (
    <div className={cn("flex flex-col gap-1.5", classNames)}>
      {showLabel && (
        <Label htmlFor={id}>
          {label}
          {required && " *"}
        </Label>
      )}
      {showDescription && <p className="text-muted-foreground text-xs">{rawDescription}</p>}
      {children}
      {rawErrors && rawErrors.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {rawErrors.map((err, i) => (
            <li key={i} className="text-destructive text-xs">
              {err}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TitleFieldTemplate(props: TitleFieldProps) {
  const { title, required, id } = props;
  if (!title) return null;
  return (
    <h3 id={id} className="text-sm font-medium">
      {title}
      {required && " *"}
    </h3>
  );
}

export function DescriptionFieldTemplate(props: DescriptionFieldProps) {
  const { description, id } = props;
  if (!description) return null;
  return (
    <p id={id} className="text-muted-foreground text-xs">
      {description}
    </p>
  );
}

export function MultiSchemaFieldTemplate(props: MultiSchemaFieldTemplateProps) {
  const { selector, optionSchemaField } = props;
  return (
    <div className="flex flex-col gap-4">
      {selector}
      {optionSchemaField}
    </div>
  );
}

export function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { title, description, properties, fieldPathId } = props;
  const isRoot = fieldPathId?.$id === "root";
  return (
    <div className={isRoot ? "flex flex-col gap-6" : "flex flex-col gap-4"}>
      {title && !isRoot && <h3 className="text-sm font-medium">{title}</h3>}
      {description && !isRoot && <p className="text-muted-foreground text-xs">{description}</p>}
      {properties.map((p) => (
        <div key={p.name}>{p.content}</div>
      ))}
    </div>
  );
}

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, buttonsProps, hasToolbar, registry } = props;
  const { labels } = (registry.formContext ?? {}) as SchemaFormContext;
  const {
    hasMoveUp,
    hasMoveDown,
    hasRemove,
    disabled,
    onMoveUpItem,
    onMoveDownItem,
    onRemoveItem,
  } = buttonsProps;
  return (
    <div className="border-border bg-muted/30 relative flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-col gap-3">{children}</div>
      {hasToolbar && (hasMoveUp || hasMoveDown || hasRemove) && !disabled && (
        <div className="flex justify-end gap-1">
          {hasMoveUp && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onMoveUpItem}
              aria-label={labels?.moveItemUp ?? "Move up"}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
          {hasMoveDown && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onMoveDownItem}
              aria-label={labels?.moveItemDown ?? "Move down"}
            >
              <ArrowDown className="size-4" />
            </Button>
          )}
          {hasRemove && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onRemoveItem}
              aria-label={labels?.removeItem ?? "Remove"}
            >
              <Trash2 className="text-destructive size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { items, canAdd, onAddClick, disabled, readonly, title, schema, uiSchema, registry } =
    props;
  const description = (uiSchema?.["ui:description"] as string | undefined) ?? schema.description;
  const ctx = (registry.formContext ?? {}) as SchemaFormContext;
  return (
    <div className="space-y-3">
      {title && <h3 className="text-sm font-medium">{title}</h3>}
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
      {items && items.length > 0 && <div className="flex flex-col gap-2">{items}</div>}
      {canAdd && !readonly && (
        <Button type="button" variant="outline" size="sm" onClick={onAddClick} disabled={disabled}>
          <Plus className="mr-1 size-4" />
          {ctx.labels?.addItem ?? "Add"}
        </Button>
      )}
    </div>
  );
}

export function SubmitButton(props: SubmitButtonProps) {
  const { uiSchema } = props;
  const { norender, submitText, props: btnProps } = getSubmitButtonOptions(uiSchema);
  if (norender) return null;
  return (
    <Button type="submit" {...btnProps}>
      {submitText ?? "Submit"}
    </Button>
  );
}
