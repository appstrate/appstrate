// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toSlug, toLiveSlug, toCredentialKey, toLiveCredentialKey } from "../../lib/strings";
import { CREDENTIAL_KEY_RE } from "@appstrate/core/validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionCard } from "../section-card";

export interface SchemaField {
  _id: string;
  key: string;
  type: string;
  description: string;
  required: boolean;
  isFile?: boolean;
  placeholder?: string;
  default?: string;
  enumValues?: string;
  format?: string;
  accept?: string;
  maxSize?: string;
  multiple?: boolean;
  maxFiles?: string;
  /** Minimum value for number/integer fields. */
  minimum?: string;
  /** Maximum value for number/integer fields. */
  maximum?: string;
  /** Step/multipleOf for number/integer fields. */
  step?: string;
  /** Minimum length for string fields. */
  minLength?: string;
  /** Maximum length for string fields. */
  maxLength?: string;
  /** Regex pattern for string fields. */
  pattern?: string;
  /** Comma-separated enum values for array items (multiselect). */
  arrayEnumItems?: string;
}

type SchemaMode = "input" | "output" | "config" | "credentials";

interface SchemaSectionProps {
  title: string;
  mode: SchemaMode;
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
  readOnly?: boolean;
}

const TYPE_OPTIONS = ["string", "number", "integer", "boolean", "array", "object"];

const STRING_FORMAT_OPTIONS = [
  { value: "", label: "—" },
  { value: "email", label: "Email" },
  { value: "password", label: "Password" },
  { value: "date", label: "Date" },
  { value: "date-time", label: "Date-Time" },
  { value: "time", label: "Time" },
  { value: "color", label: "Color" },
  { value: "uri", label: "URL" },
];

function emptyField(mode: SchemaMode): SchemaField {
  return {
    _id: crypto.randomUUID(),
    key: "",
    type: "string",
    description: "",
    required: false,
    ...(mode === "input" ? { placeholder: "", default: "" } : {}),
    ...(mode === "config" ? { default: "", enumValues: "" } : {}),
  };
}

function hasDetailsRow(mode: SchemaMode): boolean {
  return mode === "input" || mode === "config";
}

function SortableFieldCard({
  field,
  index,
  mode,
  readOnly,
  onUpdate,
  onRemove,
}: {
  field: SchemaField;
  index: number;
  mode: SchemaMode;
  readOnly?: boolean;
  onUpdate: (index: number, patch: Partial<SchemaField>) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: field._id,
    disabled: readOnly,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const isFile = mode === "input" && !!field.isFile;
  const showDetails = hasDetailsRow(mode);
  const isNumeric = field.type === "number" || field.type === "integer";
  const isString = field.type === "string" && !isFile;
  const isArray = field.type === "array";

  // Credential keys must match the sidecar substitution contract (underscore-based,
  // no hyphens) — agent/tool input/config keys stay slug-based (hyphen-based,
  // URL-safe). See @appstrate/core/validation#CREDENTIAL_KEY_RE.
  const keyTransform =
    mode === "credentials"
      ? { live: toLiveCredentialKey, final: toCredentialKey }
      : { live: toLiveSlug, final: toSlug };
  const keyIsInvalid =
    mode === "credentials" && field.key.length > 0 && !CREDENTIAL_KEY_RE.test(field.key);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border-border bg-card mb-2 rounded-md border p-2.5 [&[style*='transform']]:z-10 [&[style*='transform']]:shadow-lg"
    >
      <div className="flex items-center gap-2">
        {!readOnly && (
          <span
            className="text-muted-foreground hover:text-foreground cursor-grab text-base leading-none select-none active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            ⠿
          </span>
        )}
        <Input
          type="text"
          placeholder={t("editor.fieldKey")}
          value={field.key}
          onChange={(e) => onUpdate(index, { key: keyTransform.live(e.target.value) })}
          onBlur={() => onUpdate(index, { key: keyTransform.final(field.key) })}
          className={`h-7 w-[120px] min-w-0 shrink-0 font-mono text-xs ${
            keyIsInvalid ? "border-destructive focus-visible:ring-destructive" : ""
          }`}
          disabled={readOnly}
          aria-invalid={keyIsInvalid || undefined}
        />
        <Select
          value={field.type}
          onValueChange={(v) =>
            onUpdate(index, { type: v, ...(v !== "string" ? { isFile: false } : {}) })
          }
          disabled={readOnly}
        >
          <SelectTrigger className="h-7 w-[100px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="text"
          placeholder={t("editor.fieldDesc")}
          value={field.description}
          onChange={(e) => onUpdate(index, { description: e.target.value })}
          className="h-7 min-w-0 flex-1 text-xs"
          disabled={readOnly}
        />
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`field-req-${index}`}
            checked={field.required}
            onCheckedChange={(checked) => onUpdate(index, { required: Boolean(checked) })}
            disabled={readOnly}
          />
          <Label
            htmlFor={`field-req-${index}`}
            className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
          >
            {t("editor.fieldReq")}
          </Label>
        </div>
        {mode === "input" && field.type === "string" && (
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={`field-file-${index}`}
              checked={field.isFile ?? false}
              onCheckedChange={(checked) => onUpdate(index, { isFile: Boolean(checked) })}
              disabled={readOnly}
            />
            <Label
              htmlFor={`field-file-${index}`}
              className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
            >
              {t("editor.fieldIsFile")}
            </Label>
          </div>
        )}
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive h-7 w-7"
            onClick={() => onRemove(index)}
          >
            &times;
          </Button>
        )}
      </div>
      {showDetails && (
        <div className="mt-2 flex flex-wrap gap-2">
          {isFile ? (
            <>
              <Input
                type="text"
                placeholder={t("editor.fieldAccept")}
                value={field.accept ?? ""}
                onChange={(e) => onUpdate(index, { accept: e.target.value })}
                className="h-7 min-w-[100px] flex-1 text-xs"
                disabled={readOnly}
              />
              <Input
                type="text"
                placeholder={t("editor.fieldMaxSize")}
                value={field.maxSize ?? ""}
                onChange={(e) => onUpdate(index, { maxSize: e.target.value })}
                className="h-7 min-w-[100px] flex-1 text-xs"
                disabled={readOnly}
              />
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id={`field-multiple-${index}`}
                  checked={field.multiple ?? false}
                  onCheckedChange={(checked) => onUpdate(index, { multiple: Boolean(checked) })}
                  disabled={readOnly}
                />
                <Label
                  htmlFor={`field-multiple-${index}`}
                  className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
                >
                  {t("editor.fieldMultiple")}
                </Label>
              </div>
              {field.multiple && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldMaxFiles")}
                  value={field.maxFiles ?? ""}
                  onChange={(e) => onUpdate(index, { maxFiles: e.target.value })}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                  disabled={readOnly}
                />
              )}
            </>
          ) : (
            <>
              {(mode === "input" || mode === "config") && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldDefault")}
                  value={field.default ?? ""}
                  onChange={(e) => onUpdate(index, { default: e.target.value })}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                  disabled={readOnly}
                />
              )}
              {mode === "input" && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldPlaceholder")}
                  value={field.placeholder ?? ""}
                  onChange={(e) => onUpdate(index, { placeholder: e.target.value })}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                  disabled={readOnly}
                />
              )}
              {mode === "config" && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldEnum")}
                  value={field.enumValues ?? ""}
                  onChange={(e) => onUpdate(index, { enumValues: e.target.value })}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                  disabled={readOnly}
                />
              )}
              {/* String format dropdown */}
              {isString && (
                <Select
                  value={field.format ?? ""}
                  onValueChange={(v) => onUpdate(index, { format: v || undefined })}
                  disabled={readOnly}
                >
                  <SelectTrigger className="h-7 w-[110px] text-xs">
                    <SelectValue placeholder="Format" />
                  </SelectTrigger>
                  <SelectContent>
                    {STRING_FORMAT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value || "__none"} value={opt.value || "__none"}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* String constraints */}
              {isString && (
                <>
                  <Input
                    type="text"
                    placeholder="minLength"
                    value={field.minLength ?? ""}
                    onChange={(e) => onUpdate(index, { minLength: e.target.value })}
                    className="h-7 w-[90px] text-xs"
                    disabled={readOnly}
                  />
                  <Input
                    type="text"
                    placeholder="maxLength"
                    value={field.maxLength ?? ""}
                    onChange={(e) => onUpdate(index, { maxLength: e.target.value })}
                    className="h-7 w-[90px] text-xs"
                    disabled={readOnly}
                  />
                  <Input
                    type="text"
                    placeholder="pattern"
                    value={field.pattern ?? ""}
                    onChange={(e) => onUpdate(index, { pattern: e.target.value })}
                    className="h-7 min-w-[100px] flex-1 font-mono text-xs"
                    disabled={readOnly}
                  />
                </>
              )}
              {/* Number/integer constraints */}
              {isNumeric && (
                <>
                  <Input
                    type="text"
                    placeholder="min"
                    value={field.minimum ?? ""}
                    onChange={(e) => onUpdate(index, { minimum: e.target.value })}
                    className="h-7 w-[70px] text-xs"
                    disabled={readOnly}
                  />
                  <Input
                    type="text"
                    placeholder="max"
                    value={field.maximum ?? ""}
                    onChange={(e) => onUpdate(index, { maximum: e.target.value })}
                    className="h-7 w-[70px] text-xs"
                    disabled={readOnly}
                  />
                  <Input
                    type="text"
                    placeholder="step"
                    value={field.step ?? ""}
                    onChange={(e) => onUpdate(index, { step: e.target.value })}
                    className="h-7 w-[70px] text-xs"
                    disabled={readOnly}
                  />
                </>
              )}
              {/* Array enum items (for multiselect) */}
              {isArray && (
                <Input
                  type="text"
                  placeholder="Enum items (a, b, c)"
                  value={field.arrayEnumItems ?? ""}
                  onChange={(e) => onUpdate(index, { arrayEnumItems: e.target.value })}
                  className="h-7 min-w-[150px] flex-1 text-xs"
                  disabled={readOnly}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaSection({ title, mode, fields, onChange, readOnly }: SchemaSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const add = () => onChange([...fields, emptyField(mode)]);

  const update = (index: number, patch: Partial<SchemaField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = fields.findIndex((f) => f._id === active.id);
      const newIndex = fields.findIndex((f) => f._id === over.id);
      onChange(arrayMove(fields, oldIndex, newIndex));
    }
  }

  return (
    <SectionCard title={title}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fields.map((f) => f._id)} strategy={verticalListSortingStrategy}>
          {fields.map((field, i) => (
            <SortableFieldCard
              key={field._id}
              field={field}
              index={i}
              mode={mode}
              readOnly={readOnly}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
        </SortableContext>
      </DndContext>
      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-foreground border-dashed"
          onClick={add}
        >
          {t("editor.addField")}
        </Button>
      )}
    </SectionCard>
  );
}
