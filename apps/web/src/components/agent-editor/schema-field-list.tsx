// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's input or output fields, as the Définition shows them: one line
 * per field, and a modal to change one.
 *
 * The page editor puts every option of every field on screen at once — a
 * dozen inputs per field, most of them empty for most fields — which buried
 * the three facts a field is mostly about (its name, its type, whether it is
 * required). Here those are a table's columns; everything else is in the
 * modal, the essentials first and the options for the field's type folded
 * under them.
 *
 * Stock parts only: shadcn's `Table`, with `@dnd-kit` sortable rows the way
 * shadcn's own `dashboard-01` block drags them, and the row's deeds behind the
 * standard "…" menu — the row itself is not a button.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces, ChevronDown, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu";
import { useModalParam } from "../../hooks/use-modal-param";
import type { JSONSchema7, JSONSchema7TypeName } from "@appstrate/core/form";
import { toLiveSlug, toSlug } from "../../lib/strings";
import { Modal } from "../modal";
import { EmptyState } from "../page-states";
import { TableRowActions } from "../table-row-actions";
import type { SchemaField } from "./schema-section";
import { DraftInput, KeywordInput, NumberKeywordInput } from "./keyword-inputs";
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

type SchemaMode = "input" | "output";

const TYPE_OPTIONS: JSONSchema7TypeName[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
];
const STRING_FORMATS = ["", "email", "password", "date", "date-time", "time", "color", "uri"];

export function SchemaFieldList({
  title,
  mode,
  fields,
  onChange,
}: {
  title: string;
  mode: SchemaMode;
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  // The field being edited, by id, or "new" — an address like every modal.
  const editing = useModalParam(`field-${mode}`);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const target =
    editing.value === "new" ? blankField() : fields.find((field) => field._id === editing.value);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex((f) => f._id === active.id);
    const to = fields.findIndex((f) => f._id === over.id);
    onChange(arrayMove(fields, from, to));
  };

  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="secondary">{fields.length}</Badge>
        </div>
        {/* The list's one "Actions" menu, white like every table's, as the
            skills and integrations sections have it. */}
        <PageActionsMenu>
          <DropdownMenuItem onSelect={() => editing.open("new")}>
            <Plus />
            {t("editor.fieldAdd")}
          </DropdownMenuItem>
        </PageActionsMenu>
      </div>

      {fields.length === 0 ? (
        <EmptyState message={t("editor.fieldEmpty")} icon={Braces} compact />
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t("editor.fieldKeyLabel")}</TableHead>
                  <TableHead>{t("editor.fieldTypeLabel")}</TableHead>
                  <TableHead>{t("editor.fieldRequired")}</TableHead>
                  <TableHead>{t("editor.fieldDescLabel")}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <SortableContext
                  items={fields.map((f) => f._id)}
                  strategy={verticalListSortingStrategy}
                >
                  {fields.map((field) => (
                    <FieldRow
                      key={field._id}
                      field={field}
                      mode={mode}
                      onEdit={() => editing.open(field._id)}
                      onRemove={() => onChange(fields.filter((f) => f._id !== field._id))}
                    />
                  ))}
                </SortableContext>
              </TableBody>
            </Table>
          </DndContext>
        </div>
      )}

      {target && (
        <FieldModal
          key={target._id}
          mode={mode}
          field={target}
          isNew={editing.value === "new"}
          takenKeys={fields.filter((f) => f._id !== target._id).map((f) => f.key)}
          onClose={editing.close}
          onSave={(next) => {
            onChange(
              editing.value === "new"
                ? [...fields, next]
                : fields.map((f) => (f._id === next._id ? next : f)),
            );
            editing.close();
          }}
        />
      )}
    </section>
  );
}

function blankField(): SchemaField {
  return { _id: crypto.randomUUID(), key: "", required: false, prop: { type: "string" } };
}

function FieldRow({
  field,
  mode,
  onEdit,
  onRemove,
}: {
  field: SchemaField;
  mode: SchemaMode;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: field._id,
  });
  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="relative data-[dragging=true]:z-10"
    >
      <TableCell>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-7 cursor-grab active:cursor-grabbing"
          aria-label={t("editor.fieldReorder", { name: field.key })}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </Button>
      </TableCell>
      <TableCell className="text-sm">{field.key || "—"}</TableCell>
      <TableCell>
        <Badge variant="outline" className="font-normal">
          {fileKind(field.prop, mode) !== "none"
            ? t("editor.fieldTypeFile")
            : fieldType(field.prop, mode)}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {field.required ? t("editor.fieldRequiredYes") : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[20rem] truncate text-sm">
        {field.prop.description || "—"}
      </TableCell>
      <TableCell className="text-right">
        <TableRowActions menuLabel={t("editor.fieldActions", { name: field.key })}>
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {t("btn.edit", { ns: "common" })}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRemove} className="text-destructive focus:text-destructive">
            <Trash2 />
            {t("btn.delete", { ns: "common" })}
          </DropdownMenuItem>
        </TableRowActions>
      </TableCell>
    </TableRow>
  );
}

function FieldModal({
  mode,
  field,
  isNew,
  takenKeys,
  onClose,
  onSave,
}: {
  mode: SchemaMode;
  field: SchemaField;
  isNew: boolean;
  takenKeys: string[];
  onClose: () => void;
  onSave: (field: SchemaField) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [draft, setDraft] = useState<SchemaField>(field);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<SchemaField>) => setDraft((d) => ({ ...d, ...patch }));

  const { prop } = draft;
  const setProp = (next: JSONSchema7) => set({ prop: next });
  const key = toSlug(draft.key);
  const keyError = !key
    ? t("editor.fieldKeyRequired")
    : takenKeys.includes(key)
      ? t("editor.fieldKeyTaken")
      : null;
  const type = fieldType(prop, mode);
  const kind = fileKind(prop, mode);
  const isFile = kind !== "none";
  const isString = type === "string" && !isFile;
  const isNumeric = type === "number" || type === "integer";
  const isArray = type === "array";
  const itemsEnum = itemsEnumText(prop);

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? t("editor.fieldNew") : t("editor.fieldEditTitle", { name: field.key })}
      className="sm:max-w-xl"
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button
            type="button"
            disabled={Boolean(keyError)}
            onClick={() => onSave({ ...draft, key })}
          >
            {t("editor.apply")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label={t("editor.fieldKeyLabel")} error={draft.key ? keyError : null}>
            <Input
              value={draft.key}
              onChange={(e) => set({ key: toLiveSlug(e.target.value) })}
              className="font-mono"
              autoFocus
            />
          </Row>
          <Row label={t("editor.fieldTypeLabel")}>
            <Select
              value={isFile ? "file" : type}
              onValueChange={(v) => {
                if (v === "file") {
                  if (!isFile) setProp(setFileKind(prop, "single"));
                  return;
                }
                const next = TYPE_OPTIONS.find((o) => o === v);
                if (next && (isFile || next !== type)) setProp(changeType(prop, next));
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
                {mode === "input" && (
                  <SelectItem value="file">{t("editor.fieldTypeFile")}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </Row>
        </div>
        <Row label={t("editor.fieldDescLabel")}>
          <Input
            value={prop.description ?? ""}
            onChange={(e) => setProp(setKeyword(prop, "description", e.target.value || undefined))}
          />
        </Row>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.required}
            onCheckedChange={(v) => set({ required: Boolean(v) })}
          />
          {t("editor.fieldRequired")}
        </label>

        {mode === "input" && (
          <div className="border-border border-t pt-3">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              <ChevronDown className={advanced ? "size-4 rotate-180" : "size-4"} />
              {t("editor.fieldAdvanced")}
            </button>
            {advanced && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {isFile ? (
                  <>
                    <Row label={t("editor.fieldAcceptLabel")}>
                      <Input
                        value={draft.accept ?? ""}
                        onChange={(e) => set({ accept: e.target.value })}
                      />
                    </Row>
                    <Row label={t("editor.fieldMaxSizeLabel")}>
                      <DraftInput
                        text={draft.maxSize !== undefined ? String(draft.maxSize) : ""}
                        onCommit={(text) => set({ maxSize: toKeywordNumber("maxSize", text) })} // canonical-casing-exempt: SchemaField TS-internal; written as `max_size`
                      />
                    </Row>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={kind === "multiple"}
                        onCheckedChange={(v) =>
                          setProp(setFileKind(prop, v ? "multiple" : "single"))
                        }
                      />
                      {t("editor.fieldMultipleLabel")}
                    </label>
                    {kind === "multiple" && (
                      <Row label={t("editor.fieldMaxFilesLabel")}>
                        <NumberKeywordInput
                          prop={prop}
                          keyword="maxItems"
                          placeholder=""
                          className=""
                          onChange={setProp}
                        />
                      </Row>
                    )}
                  </>
                ) : (
                  <>
                    {(isTextType(type) || prop.default !== undefined) && (
                      <Row label={t("editor.fieldDefaultLabel")}>
                        <KeywordInput
                          value={valueToText(prop.default, type)}
                          onCommit={(text) =>
                            setProp(setKeyword(prop, "default", textToValue(text, type)))
                          }
                          placeholder=""
                          className=""
                        />
                      </Row>
                    )}
                    <Row label={t("editor.fieldPlaceholderLabel")}>
                      <Input
                        value={draft.placeholder ?? ""}
                        onChange={(e) => set({ placeholder: e.target.value })}
                      />
                    </Row>
                    {isArray
                      ? (isTextType(itemType(prop)) || itemsEnum.locked) && (
                          <Row label={t("editor.fieldEnumLabel")}>
                            <KeywordInput
                              value={itemsEnum}
                              onCommit={(text) =>
                                setProp(setItemsEnum(prop, textToList(text, itemType(prop))))
                              }
                              placeholder=""
                              className=""
                            />
                          </Row>
                        )
                      : (isTextType(type) || prop.enum !== undefined) && (
                          <Row label={t("editor.fieldEnumLabel")}>
                            <KeywordInput
                              value={listToText(prop.enum, type)}
                              onCommit={(text) => {
                                const values = textToList(text, type);
                                setProp(
                                  setKeyword(prop, "enum", values.length > 0 ? values : undefined),
                                );
                              }}
                              placeholder=""
                              className=""
                            />
                          </Row>
                        )}
                    {isString && (
                      <>
                        <Row label={t("editor.fieldFormat")}>
                          <Select
                            value={prop.format || "__none"}
                            onValueChange={(v) =>
                              setProp(setKeyword(prop, "format", v === "__none" ? undefined : v))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STRING_FORMATS.map((format) => (
                                <SelectItem key={format || "__none"} value={format || "__none"}>
                                  {format || "—"}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Row>
                        <Row label={t("editor.fieldMinLength")}>
                          <NumberKeywordInput
                            prop={prop}
                            keyword="minLength"
                            placeholder=""
                            className=""
                            onChange={setProp}
                          />
                        </Row>
                        <Row label={t("editor.fieldMaxLength")}>
                          <NumberKeywordInput
                            prop={prop}
                            keyword="maxLength"
                            placeholder=""
                            className=""
                            onChange={setProp}
                          />
                        </Row>
                        <Row label={t("editor.fieldPattern")}>
                          <Input
                            value={prop.pattern ?? ""}
                            onChange={(e) =>
                              setProp(setKeyword(prop, "pattern", e.target.value || undefined))
                            }
                            className="font-mono"
                          />
                        </Row>
                      </>
                    )}
                    {isNumeric && (
                      <>
                        <Row label={t("editor.fieldMin")}>
                          <NumberKeywordInput
                            prop={prop}
                            keyword="minimum"
                            placeholder=""
                            className=""
                            onChange={setProp}
                          />
                        </Row>
                        <Row label={t("editor.fieldMax")}>
                          <NumberKeywordInput
                            prop={prop}
                            keyword="maximum"
                            placeholder=""
                            className=""
                            onChange={setProp}
                          />
                        </Row>
                        <Row label={t("editor.fieldStep")}>
                          <NumberKeywordInput
                            prop={prop}
                            keyword="multipleOf"
                            placeholder=""
                            className=""
                            onChange={setProp}
                          />
                        </Row>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
