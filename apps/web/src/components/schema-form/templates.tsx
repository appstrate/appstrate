// SPDX-License-Identifier: Apache-2.0

/**
 * Tailwind-styled RJSF templates matching the Appstrate dark theme.
 * Only templates we actually want to restyle are overridden — RJSF
 * defaults handle the rest.
 */

import type {
  BaseInputTemplateProps,
  FieldTemplateProps,
  TitleFieldProps,
  DescriptionFieldProps,
  SubmitButtonProps,
  ArrayFieldTemplateProps,
  ArrayFieldItemTemplateProps,
  ObjectFieldTemplateProps,
} from "@rjsf/utils";
import { getSubmitButtonOptions } from "@rjsf/utils";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const inputType = type ?? formatType;

  const isConst = schema && "const" in schema;
  const isReadOnly = readonly || isConst;
  return (
    <Input
      id={id}
      type={inputType}
      value={(value as string | number | undefined) ?? ""}
      required={required}
      readOnly={isReadOnly}
      disabled={disabled}
      autoFocus={autofocus && !isReadOnly}
      placeholder={(placeholder ?? (options?.["ui:placeholder"] as string | undefined)) as string}
      className={cn(
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
    <div className={cn("space-y-1.5", classNames)}>
      {showLabel && (
        <Label htmlFor={id}>
          {label}
          {required && " *"}
        </Label>
      )}
      {showDescription && <p className="text-muted-foreground text-xs">{rawDescription}</p>}
      {children}
      {rawErrors && rawErrors.length > 0 && (
        <ul className="space-y-0.5">
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

export function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { title, description, properties, fieldPathId } = props;
  const isRoot = fieldPathId?.$id === "root";
  return (
    <div className={isRoot ? "space-y-6" : "space-y-4"}>
      {title && !isRoot && <h3 className="text-sm font-medium">{title}</h3>}
      {description && !isRoot && <p className="text-muted-foreground text-xs">{description}</p>}
      {properties.map((p) => (
        <div key={p.name}>{p.content}</div>
      ))}
    </div>
  );
}

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, buttonsProps, hasToolbar } = props;
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
    <div className="border-border bg-muted/30 relative space-y-2 rounded-md border p-3">
      <div className="space-y-3">{children}</div>
      {hasToolbar && (hasMoveUp || hasMoveDown || hasRemove) && !disabled && (
        <div className="flex justify-end gap-1">
          {hasMoveUp && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onMoveUpItem}
              aria-label="Move up"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          {hasMoveDown && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onMoveDownItem}
              aria-label="Move down"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          )}
          {hasRemove && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onRemoveItem}
              aria-label="Remove"
            >
              <Trash2 className="text-destructive h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { items, canAdd, onAddClick, disabled, readonly, title, schema, uiSchema } = props;
  const description = (uiSchema?.["ui:description"] as string | undefined) ?? schema.description;
  return (
    <div className="space-y-3">
      {title && <h3 className="text-sm font-medium">{title}</h3>}
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
      {items && items.length > 0 && <div className="space-y-2">{items}</div>}
      {canAdd && !readonly && (
        <Button type="button" variant="outline" size="sm" onClick={onAddClick} disabled={disabled}>
          <Plus className="mr-1 h-4 w-4" />
          Ajouter
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
