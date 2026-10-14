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
import { useId, useState } from "react";
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
import { FormItem } from "@appstrate/ui/components/field";
import { OptionSelect } from "@appstrate/ui/components/select";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import type { JSONSchema7, JSONSchema7TypeName } from "@appstrate/core/form";
import { toLiveSlug } from "../../lib/strings";
import { fieldKeyVerdict } from "../../lib/schema-field-key";
import { Modal } from "../modal";
import { EmptyState, EmptyStateAction } from "../page-states";
import { TableRowActions } from "../table-row-actions";
import type { SchemaField } from "./types";
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

/** Each list's two addresses: both lists can sit on one page. */
const FIELD_PARAMS = {
  input: { add: "newInputField", edit: "editInputField" },
  output: { add: "newOutputField", edit: "editOutputField" },
} as const satisfies Record<SchemaMode, { add: string; edit: string }>;

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
  // Addresses like every modal: a field by its key, which survives a reload.
  const adding = useModalParam(FIELD_PARAMS[mode].add);
  const editing = useModalTarget(FIELD_PARAMS[mode].edit, fields, (field) => field.key);
  const target = editing.target;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
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
          <DropdownMenuItem onSelect={() => adding.open()}>
            <Plus />
            {t("editor.fieldAdd")}
          </DropdownMenuItem>
        </PageActionsMenu>
      </div>

      {fields.length === 0 ? (
        <EmptyState message={t("editor.fieldEmpty")} icon={Braces} compact>
          <EmptyStateAction label={t("editor.fieldAdd")} onClick={() => adding.open()} />
        </EmptyState>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            {/* Fixed layout: the input and output tables stack on one page and their columns line up. */}
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-[26%]">{t("editor.fieldKeyLabel")}</TableHead>
                  <TableHead className="w-[16%]">{t("editor.fieldTypeLabel")}</TableHead>
                  <TableHead className="w-[12%]">{t("editor.fieldRequired")}</TableHead>
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
                      onEdit={() => editing.open(field.key)}
                      onRemove={() => onChange(fields.filter((f) => f._id !== field._id))}
                    />
                  ))}
                </SortableContext>
              </TableBody>
            </Table>
          </DndContext>
        </div>
      )}

      {adding.value !== null ? (
        <FieldModal
          mode={mode}
          takenKeys={fields.map((f) => f.key)}
          onClose={adding.close}
          onSave={(next) => {
            onChange([...fields, next]);
            adding.close();
          }}
        />
      ) : (
        target && (
          <FieldModal
            key={target._id}
            mode={mode}
            field={target}
            takenKeys={fields.filter((f) => f._id !== target._id).map((f) => f.key)}
            onClose={editing.close}
            onSave={(next) => {
              onChange(fields.map((f) => (f._id === next._id ? next : f)));
              editing.close();
            }}
          />
        )
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
        <TableRowActions
          menuLabel={t("editor.fieldActions", { name: field.key })}
          actions={[
            {
              id: "edit",
              label: t("btn.edit", { ns: "common" }),
              icon: Pencil,
              onSelect: onEdit,
            },
            {
              id: "remove",
              label: t("btn.delete", { ns: "common" }),
              icon: Trash2,
              onSelect: onRemove,
              destructive: true,
            },
          ]}
        />
      </TableCell>
    </TableRow>
  );
}

/** Edits `field`, or a new one when there is none. */
function FieldModal({
  mode,
  field,
  takenKeys,
  onClose,
  onSave,
}: {
  mode: SchemaMode;
  field?: SchemaField;
  takenKeys: string[];
  onClose: () => void;
  onSave: (field: SchemaField) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [draft, setDraft] = useState<SchemaField>(() => field ?? blankField());
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<SchemaField>) => setDraft((d) => ({ ...d, ...patch }));

  const { prop } = draft;
  const setProp = (next: JSONSchema7) => set({ prop: next });
  const verdict = fieldKeyVerdict(draft.key, takenKeys);
  const { key } = verdict;
  const keyError = verdict.error ? t(verdict.error) : null;
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
      title={field ? t("editor.fieldEditTitle", { name: field.key }) : t("editor.fieldNew")}
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
            {(id) => (
              <Input
                id={id}
                value={draft.key}
                onChange={(e) => set({ key: toLiveSlug(e.target.value) })}
                className="font-mono"
                autoFocus
              />
            )}
          </Row>
          <Row label={t("editor.fieldTypeLabel")}>
            {(id) => (
              <OptionSelect
                id={id}
                value={isFile ? "file" : type}
                onValueChange={(v) => {
                  if (v === "file") {
                    if (!isFile) setProp(setFileKind(prop, "single"));
                    return;
                  }
                  const next = TYPE_OPTIONS.find((o) => o === v);
                  if (next && (isFile || next !== type)) setProp(changeType(prop, next));
                }}
                options={[
                  ...TYPE_OPTIONS.map((option) => ({ value: option, label: option })),
                  ...(mode === "input"
                    ? [{ value: "file", label: t("editor.fieldTypeFile") }]
                    : []),
                ]}
              />
            )}
          </Row>
        </div>
        <Row label={t("editor.fieldDescLabel")}>
          {(id) => (
            <Input
              id={id}
              value={prop.description ?? ""}
              onChange={(e) =>
                setProp(setKeyword(prop, "description", e.target.value || undefined))
              }
            />
          )}
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
                      {(id) => (
                        <Input
                          id={id}
                          value={draft.accept ?? ""}
                          onChange={(e) => set({ accept: e.target.value })}
                        />
                      )}
                    </Row>
                    <Row label={t("editor.fieldMaxSizeLabel")}>
                      {(id) => (
                        <DraftInput
                          id={id}
                          text={draft.maxSize !== undefined ? String(draft.maxSize) : ""}
                          onCommit={(text) => set({ maxSize: toKeywordNumber("maxSize", text) })} // canonical-casing-exempt: SchemaField TS-internal; written as `max_size`
                        />
                      )}
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
                        {(id) => (
                          <NumberKeywordInput
                            id={id}
                            prop={prop}
                            keyword="maxItems"
                            onChange={setProp}
                          />
                        )}
                      </Row>
                    )}
                  </>
                ) : (
                  <>
                    {(isTextType(type) || prop.default !== undefined) && (
                      <Row label={t("editor.fieldDefaultLabel")}>
                        {(id) => (
                          <KeywordInput
                            id={id}
                            value={valueToText(prop.default, type)}
                            onCommit={(text) =>
                              setProp(setKeyword(prop, "default", textToValue(text, type)))
                            }
                          />
                        )}
                      </Row>
                    )}
                    <Row label={t("editor.fieldPlaceholderLabel")}>
                      {(id) => (
                        <Input
                          id={id}
                          value={draft.placeholder ?? ""}
                          onChange={(e) => set({ placeholder: e.target.value })}
                        />
                      )}
                    </Row>
                    {isArray
                      ? (isTextType(itemType(prop)) || itemsEnum.locked) && (
                          <Row label={t("editor.fieldEnumLabel")}>
                            {(id) => (
                              <KeywordInput
                                id={id}
                                value={itemsEnum}
                                onCommit={(text) =>
                                  setProp(setItemsEnum(prop, textToList(text, itemType(prop))))
                                }
                              />
                            )}
                          </Row>
                        )
                      : (isTextType(type) || prop.enum !== undefined) && (
                          <Row label={t("editor.fieldEnumLabel")}>
                            {(id) => (
                              <KeywordInput
                                id={id}
                                value={listToText(prop.enum, type)}
                                onCommit={(text) => {
                                  const values = textToList(text, type);
                                  setProp(
                                    setKeyword(
                                      prop,
                                      "enum",
                                      values.length > 0 ? values : undefined,
                                    ),
                                  );
                                }}
                              />
                            )}
                          </Row>
                        )}
                    {isString && (
                      <>
                        <Row label={t("editor.fieldFormat")}>
                          {(id) => (
                            <OptionSelect
                              id={id}
                              value={prop.format || "__none"}
                              onValueChange={(v) =>
                                setProp(setKeyword(prop, "format", v === "__none" ? undefined : v))
                              }
                              options={STRING_FORMATS.map((format) => ({
                                value: format || "__none",
                                label: format || "—",
                              }))}
                            />
                          )}
                        </Row>
                        <Row label={t("editor.fieldMinLength")}>
                          {(id) => (
                            <NumberKeywordInput
                              id={id}
                              prop={prop}
                              keyword="minLength"
                              onChange={setProp}
                            />
                          )}
                        </Row>
                        <Row label={t("editor.fieldMaxLength")}>
                          {(id) => (
                            <NumberKeywordInput
                              id={id}
                              prop={prop}
                              keyword="maxLength"
                              onChange={setProp}
                            />
                          )}
                        </Row>
                        <Row label={t("editor.fieldPattern")}>
                          {(id) => (
                            <Input
                              id={id}
                              value={prop.pattern ?? ""}
                              onChange={(e) =>
                                setProp(setKeyword(prop, "pattern", e.target.value || undefined))
                              }
                              className="font-mono"
                            />
                          )}
                        </Row>
                      </>
                    )}
                    {isNumeric && (
                      <>
                        <Row label={t("editor.fieldMin")}>
                          {(id) => (
                            <NumberKeywordInput
                              id={id}
                              prop={prop}
                              keyword="minimum"
                              onChange={setProp}
                            />
                          )}
                        </Row>
                        <Row label={t("editor.fieldMax")}>
                          {(id) => (
                            <NumberKeywordInput
                              id={id}
                              prop={prop}
                              keyword="maximum"
                              onChange={setProp}
                            />
                          )}
                        </Row>
                        <Row label={t("editor.fieldStep")}>
                          {(id) => (
                            <NumberKeywordInput
                              id={id}
                              prop={prop}
                              keyword="multipleOf"
                              onChange={setProp}
                            />
                          )}
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
  /** Renders the control, given the id its label names. */
  children: (id: string) => React.ReactElement;
}) {
  const id = useId();
  return (
    <FormItem id={id} label={label} error={error ?? undefined}>
      {children(id)}
    </FormItem>
  );
}
