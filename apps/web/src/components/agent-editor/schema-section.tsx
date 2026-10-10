// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { SchemaFieldList } from "./schema-field-list";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
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
import { toSlug, toLiveSlug } from "../../lib/strings";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { SectionCard } from "../section-card";
import type { JSONSchema7, JSONSchema7TypeName } from "@appstrate/core/form";
import {
  changeType,
  fieldType,
  fileKind,
  isTextType,
  itemsEnumText,
  itemType,
  listToText,
  setFileKind,
  setItemsEnum,
  setKeyword,
  textToList,
  textToValue,
  toKeywordNumber,
  valueToText,
} from "./utils";
import { DraftInput, KeywordInput, NumberKeywordInput } from "./keyword-inputs";

export interface SchemaField {
  _id: string;
  key: string;
  required: boolean;
  /** The JSON-Schema property itself: the single source of truth for every keyword. */
  prop: JSONSchema7;
  /** AFPS `file_constraints.accept` (file fields). */
  accept?: string;
  /** AFPS `file_constraints.max_size` (file fields). */
  maxSize?: number;
  /** AFPS `ui_hints.placeholder` (non-file input fields). */
  placeholder?: string;
}

type SchemaMode = "input" | "output";

interface SchemaSectionProps {
  title: string;
  mode: SchemaMode;
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
  readOnly?: boolean;
  surface?: "card" | "settings";
}

const TYPE_OPTIONS: JSONSchema7TypeName[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
];

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

function emptyField(): SchemaField {
  return { _id: crypto.randomUUID(), key: "", required: false, prop: { type: "string" } };
}

function SortableFieldCard({
  field,
  index,
  mode,
  onUpdate,
  onRemove,
}: {
  field: SchemaField;
  index: number;
  mode: SchemaMode;
  onUpdate: (index: number, patch: Partial<SchemaField>) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: field._id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const { prop } = field;
  const setProp = (next: JSONSchema7) => onUpdate(index, { prop: next });
  const type = fieldType(prop, mode);
  const kind = fileKind(prop, mode);
  const isFile = kind !== "none";
  const showDetails = mode === "input";
  const isNumeric = type === "number" || type === "integer";
  const isString = type === "string" && !isFile;
  const isArray = type === "array";
  const defaultText = valueToText(prop.default, type);
  const enumText = listToText(prop.enum, type);
  const itemsEnum = itemsEnumText(prop);

  // Agent/tool input and output keys are slug-based (hyphen-based, URL-safe):
  // `live` while the user types, `final` on blur.
  const keyTransform = { live: toLiveSlug, final: toSlug };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border-border bg-card mb-2 rounded-md border p-2.5 [&[style*='transform']]:z-10 [&[style*='transform']]:shadow-lg"
    >
      <div className="flex items-center gap-2">
        <span
          className="text-muted-foreground hover:text-foreground cursor-grab text-base leading-none select-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          ⠿
        </span>

        <Input
          type="text"
          placeholder={t("editor.fieldKey")}
          value={field.key}
          onChange={(e) => onUpdate(index, { key: keyTransform.live(e.target.value) })}
          onBlur={() => onUpdate(index, { key: keyTransform.final(field.key) })}
          className="h-7 w-[120px] min-w-0 shrink-0 font-mono text-xs"
        />
        <Select
          value={type}
          onValueChange={(v) => {
            const next = TYPE_OPTIONS.find((o) => o === v);
            if (next) setProp(changeType(prop, next));
          }}
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
          value={prop.description ?? ""}
          onChange={(e) => setProp(setKeyword(prop, "description", e.target.value || undefined))}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`field-req-${index}`}
            checked={field.required}
            onCheckedChange={(checked) => onUpdate(index, { required: Boolean(checked) })}
          />
          <Label
            htmlFor={`field-req-${index}`}
            className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
          >
            {t("editor.fieldReq")}
          </Label>
        </div>
        {mode === "input" && type === "string" && (
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={`field-file-${index}`}
              checked={isFile}
              onCheckedChange={(checked) => setProp(setFileKind(prop, checked ? "single" : "none"))}
            />
            <Label
              htmlFor={`field-file-${index}`}
              className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
            >
              {t("editor.fieldIsFile")}
            </Label>
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive h-7 w-7"
          onClick={() => onRemove(index)}
        >
          &times;
        </Button>
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
              />
              <DraftInput
                placeholder={t("editor.fieldMaxSize")}
                text={field.maxSize !== undefined ? String(field.maxSize) : ""}
                onCommit={(text) => onUpdate(index, { maxSize: toKeywordNumber("maxSize", text) })} // canonical-casing-exempt: SchemaField TS-internal (carve-out); manifest write via fieldsToSchema → `max_size`
                className="h-7 min-w-[100px] flex-1 text-xs"
              />
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id={`field-multiple-${index}`}
                  checked={kind === "multiple"}
                  onCheckedChange={(checked) =>
                    setProp(setFileKind(prop, checked ? "multiple" : "single"))
                  }
                />
                <Label
                  htmlFor={`field-multiple-${index}`}
                  className="text-muted-foreground cursor-pointer text-xs font-normal whitespace-nowrap"
                >
                  {t("editor.fieldMultiple")}
                </Label>
              </div>
              {kind === "multiple" && (
                <NumberKeywordInput
                  prop={prop}
                  keyword="maxItems"
                  placeholder={t("editor.fieldMaxFiles")}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                  onChange={setProp}
                />
              )}
            </>
          ) : (
            <>
              {(isTextType(type) || prop.default !== undefined) && (
                <KeywordInput
                  value={defaultText}
                  onCommit={(text) => setProp(setKeyword(prop, "default", textToValue(text, type)))}
                  placeholder={t("editor.fieldDefault")}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                />
              )}
              <Input
                type="text"
                placeholder={t("editor.fieldPlaceholder")}
                value={field.placeholder ?? ""}
                onChange={(e) => onUpdate(index, { placeholder: e.target.value })}
                className="h-7 min-w-[100px] flex-1 text-xs"
              />
              {(isTextType(type) || prop.enum !== undefined) && (
                <KeywordInput
                  value={enumText}
                  onCommit={(text) => {
                    const values = textToList(text, type);
                    setProp(setKeyword(prop, "enum", values.length > 0 ? values : undefined));
                  }}
                  placeholder={t("editor.fieldEnum")}
                  className="h-7 min-w-[100px] flex-1 text-xs"
                />
              )}
              {/* String format dropdown */}
              {isString && (
                <Select
                  value={prop.format ?? ""}
                  onValueChange={(v) =>
                    setProp(setKeyword(prop, "format", v === "__none" ? undefined : v))
                  }
                >
                  <SelectTrigger className="h-7 w-[110px] text-xs">
                    <SelectValue placeholder={t("editor.fieldFormat")} />
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
                  <NumberKeywordInput
                    prop={prop}
                    keyword="minLength"
                    placeholder={t("editor.fieldMinLength")}
                    className="h-7 w-[120px] text-xs"
                    onChange={setProp}
                  />
                  <NumberKeywordInput
                    prop={prop}
                    keyword="maxLength"
                    placeholder={t("editor.fieldMaxLength")}
                    className="h-7 w-[120px] text-xs"
                    onChange={setProp}
                  />
                  <Input
                    type="text"
                    placeholder={t("editor.fieldPattern")}
                    value={prop.pattern ?? ""}
                    onChange={(e) =>
                      setProp(setKeyword(prop, "pattern", e.target.value || undefined))
                    }
                    className="h-7 min-w-[100px] flex-1 font-mono text-xs"
                  />
                </>
              )}
              {/* Number/integer constraints */}
              {isNumeric && (
                <>
                  <NumberKeywordInput
                    prop={prop}
                    keyword="minimum"
                    placeholder={t("editor.fieldMin")}
                    className="h-7 w-[70px] text-xs"
                    onChange={setProp}
                  />
                  <NumberKeywordInput
                    prop={prop}
                    keyword="maximum"
                    placeholder={t("editor.fieldMax")}
                    className="h-7 w-[70px] text-xs"
                    onChange={setProp}
                  />
                  <NumberKeywordInput
                    prop={prop}
                    keyword="multipleOf"
                    placeholder={t("editor.fieldStep")}
                    className="h-7 w-[70px] text-xs"
                    onChange={setProp}
                  />
                </>
              )}
              {/* Array enum items (for multiselect) */}
              {isArray && (isTextType(itemType(prop)) || itemsEnum.locked) && (
                <KeywordInput
                  value={itemsEnum}
                  onCommit={(text) => setProp(setItemsEnum(prop, textToList(text, itemType(prop))))}
                  placeholder={t("editor.fieldItemsEnum")}
                  className="h-7 min-w-[150px] flex-1 text-xs"
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaSection({
  title,
  mode,
  fields,
  onChange,
  readOnly,
  surface = "card",
}: SchemaSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const add = () => onChange([...fields, emptyField()]);

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

  const content = (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fields.map((f) => f._id)} strategy={verticalListSortingStrategy}>
          {fields.map((field, i) => (
            <SortableFieldCard
              key={field._id}
              field={field}
              index={i}
              mode={mode}
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
    </>
  );

  if (surface === "settings") {
    return <SchemaFieldList title={title} mode={mode} fields={fields} onChange={onChange} />;
  }

  return <SectionCard title={title}>{content}</SectionCard>;
}
