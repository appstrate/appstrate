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
import { useModalParam } from "../../hooks/use-modal-param";
import { toLiveSlug, toSlug } from "../../lib/strings";
import { Modal } from "../modal";
import { EmptyState } from "../page-states";
import { TableRowActions } from "../table-row-actions";
import type { SchemaField } from "./schema-section";

type SchemaMode = "input" | "output";

const TYPE_OPTIONS = ["string", "number", "integer", "boolean", "array", "object"];
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
    editing.value === "new"
      ? blankField(mode)
      : fields.find((field) => field._id === editing.value);

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
        <Button type="button" size="sm" onClick={() => editing.open("new")}>
          <Plus />
          {t("editor.fieldAdd")}
        </Button>
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

function blankField(mode: SchemaMode): SchemaField {
  return {
    _id: crypto.randomUUID(),
    key: "",
    type: "string",
    description: "",
    required: false,
    ...(mode === "input" ? { placeholder: "", default: "", enumValues: "" } : {}),
  };
}

function FieldRow({
  field,
  onEdit,
  onRemove,
}: {
  field: SchemaField;
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
      <TableCell className="font-mono text-sm">{field.key || "—"}</TableCell>
      <TableCell>
        <Badge variant="outline" className="font-normal">
          {field.isFile ? t("editor.fieldTypeFile") : field.type}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {field.required ? t("editor.fieldRequiredYes") : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-[20rem] truncate text-sm">
        {field.description || "—"}
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

  const key = toSlug(draft.key);
  const keyError = !key
    ? t("editor.fieldKeyRequired")
    : takenKeys.includes(key)
      ? t("editor.fieldKeyTaken")
      : null;
  const isFile = mode === "input" && Boolean(draft.isFile);
  const isString = draft.type === "string" && !isFile;
  const isNumeric = draft.type === "number" || draft.type === "integer";

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
              value={isFile ? "file" : draft.type}
              onValueChange={(v) =>
                v === "file"
                  ? set({ type: "string", isFile: true })
                  : set({ type: v, isFile: false })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
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
          <Input value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </Row>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.required}
            onCheckedChange={(v) => set({ required: Boolean(v) })}
          />
          {t("editor.fieldRequired")}
        </label>

        {mode === "input" && draft.type !== "boolean" && draft.type !== "object" && (
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
                      <Input
                        value={draft.maxSize ?? ""}
                        onChange={(e) => set({ maxSize: e.target.value })} // canonical-casing-exempt: SchemaField TS-internal; written as `max_size`
                      />
                    </Row>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.multiple ?? false}
                        onCheckedChange={(v) => set({ multiple: Boolean(v) })}
                      />
                      {t("editor.fieldMultipleLabel")}
                    </label>
                    {draft.multiple && (
                      <Row label={t("editor.fieldMaxFilesLabel")}>
                        <Input
                          value={draft.maxFiles ?? ""}
                          onChange={(e) => set({ maxFiles: e.target.value })}
                        />
                      </Row>
                    )}
                  </>
                ) : (
                  <>
                    <Row label={t("editor.fieldDefaultLabel")}>
                      <Input
                        value={draft.default ?? ""}
                        onChange={(e) => set({ default: e.target.value })}
                      />
                    </Row>
                    <Row label={t("editor.fieldPlaceholderLabel")}>
                      <Input
                        value={draft.placeholder ?? ""}
                        onChange={(e) => set({ placeholder: e.target.value })}
                      />
                    </Row>
                    {draft.type === "array" ? (
                      <Row label={t("editor.fieldEnumLabel")}>
                        <Input
                          value={draft.arrayEnumItems ?? ""}
                          onChange={(e) => set({ arrayEnumItems: e.target.value })}
                        />
                      </Row>
                    ) : (
                      <Row label={t("editor.fieldEnumLabel")}>
                        <Input
                          value={draft.enumValues ?? ""}
                          onChange={(e) => set({ enumValues: e.target.value })}
                        />
                      </Row>
                    )}
                    {isString && (
                      <>
                        <Row label={t("editor.fieldFormat")}>
                          <Select
                            value={draft.format || "__none"}
                            onValueChange={(v) => set({ format: v === "__none" ? undefined : v })}
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
                        <Row label="minLength">
                          <Input
                            value={draft.minLength ?? ""}
                            onChange={(e) => set({ minLength: e.target.value })}
                          />
                        </Row>
                        <Row label="maxLength">
                          <Input
                            value={draft.maxLength ?? ""}
                            onChange={(e) => set({ maxLength: e.target.value })}
                          />
                        </Row>
                        <Row label="pattern">
                          <Input
                            value={draft.pattern ?? ""}
                            onChange={(e) => set({ pattern: e.target.value })}
                            className="font-mono"
                          />
                        </Row>
                      </>
                    )}
                    {isNumeric && (
                      <>
                        <Row label="min">
                          <Input
                            value={draft.minimum ?? ""}
                            onChange={(e) => set({ minimum: e.target.value })}
                          />
                        </Row>
                        <Row label="max">
                          <Input
                            value={draft.maximum ?? ""}
                            onChange={(e) => set({ maximum: e.target.value })}
                          />
                        </Row>
                        <Row label="step">
                          <Input
                            value={draft.step ?? ""}
                            onChange={(e) => set({ step: e.target.value })}
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
