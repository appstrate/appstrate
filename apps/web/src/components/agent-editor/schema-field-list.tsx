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
 * Stock parts only: shadcn's `Table`, a pair of up/down buttons per row for the
 * order, and the row's other deeds behind the standard "…" menu — the row itself
 * is not a button.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@/components/app-ui/form-item";
import { OptionSelect } from "@/components/app-ui/option-select";
import { PageActionsMenu } from "../page-actions-menu";
import { useUrlModalTarget } from "../../hooks/use-url-modal";
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
  moveItem,
  setFileKind,
  setItemsEnum,
  setKeyword,
  textToList,
  textToValue,
  toKeywordNumber,
  valueToText,
  type NumericKeyword,
} from "./utils";

type SchemaMode = "input" | "output";

/** Each list's edit address: both lists can sit on one page. */
const EDIT_PARAMS = {
  input: "editInputField",
  output: "editOutputField",
} as const satisfies Record<SchemaMode, string>;

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
  const [adding, setAdding] = useState(false);
  // A field's edit has an address: its key, which survives a reload.
  const editing = useUrlModalTarget(EDIT_PARAMS[mode], fields, (field) => field.key);
  const target = editing.target;

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="secondary">{fields.length}</Badge>
        </div>
        {/* The list's one "Actions" menu, white like every table's, as the
            skills and integrations sections have it. */}
        <PageActionsMenu
          actions={[
            { id: "add", label: t("editor.fieldAdd"), icon: Plus, onSelect: () => setAdding(true) },
          ]}
        />
      </div>

      {fields.length === 0 ? (
        <EmptyState message={t("editor.fieldEmpty")} icon={Braces} compact>
          <EmptyStateAction
            action={{ label: t("editor.fieldAdd"), onSelect: () => setAdding(true) }}
          />
        </EmptyState>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          {/* Fixed layout: the input and output tables stack on one page and their columns line up. */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-16" />
                <TableHead className="w-[26%]">{t("editor.fieldKeyLabel")}</TableHead>
                <TableHead className="w-[16%]">{t("log.filterType")}</TableHead>
                <TableHead className="w-[12%]">{t("manifest.required")}</TableHead>
                <TableHead>{t("editor.fieldDescLabel")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <FieldRow
                  key={field._id}
                  field={field}
                  mode={mode}
                  index={index}
                  isFirst={index === 0}
                  isLast={index === fields.length - 1}
                  onMove={(delta) => onChange(moveItem(fields, index, delta))}
                  onEdit={() => editing.open(field.key)}
                  onRemove={() => onChange(fields.filter((f) => f._id !== field._id))}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {adding ? (
        <FieldModal
          mode={mode}
          takenKeys={fields.map((f) => f.key)}
          onClose={() => setAdding(false)}
          onSave={(next) => {
            onChange([...fields, next]);
            setAdding(false);
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
  isFirst,
  isLast,
  index,
  onMove,
  onEdit,
  onRemove,
}: {
  field: SchemaField;
  mode: SchemaMode;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const lastMove = useRef<-1 | 1 | null>(null);
  // Moving a row moves its DOM node, which drops the keyboard focus: give it back to the
  // button that was used, or to the other one once that one has hit an end.
  useEffect(() => {
    const delta = lastMove.current;
    lastMove.current = null;
    if (delta === null) return;
    const blocked = delta === -1 ? isFirst : isLast;
    (blocked ? (delta === -1 ? down : up) : delta === -1 ? up : down).current?.focus();
  }, [index, isFirst, isLast]);
  const move = (delta: -1 | 1) => {
    lastMove.current = delta;
    onMove(delta);
  };
  return (
    <TableRow>
      <TableCell>
        <div className="flex">
          <Button
            ref={up}
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7"
            disabled={isFirst}
            aria-label={t("editor.fieldMoveUp", { name: field.key })}
            onClick={() => move(-1)}
          >
            <ChevronUp />
          </Button>
          <Button
            ref={down}
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7"
            disabled={isLast}
            aria-label={t("editor.fieldMoveDown", { name: field.key })}
            onClick={() => move(1)}
          >
            <ChevronDown />
          </Button>
        </div>
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
          menuLabel={t("editor.rowActions", { name: field.key })}
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
  const ids = useId();
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
  const enumRow = isArray
    ? {
        show: isTextType(itemType(prop)) || itemsEnum.locked,
        value: itemsEnum,
        commit: (text: string) => setProp(setItemsEnum(prop, textToList(text, itemType(prop)))),
      }
    : {
        show: isTextType(type) || prop.enum !== undefined,
        value: listToText(prop.enum, type),
        commit: (text: string) => {
          const values = textToList(text, type);
          setProp(setKeyword(prop, "enum", values.length > 0 ? values : undefined));
        },
      };

  return (
    <Modal
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
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label={t("editor.fieldKeyLabel")} error={draft.key ? keyError : null}>
            <Input
              value={draft.key}
              onChange={(e) => set({ key: toLiveSlug(e.target.value) })}
              className="font-mono"
              autoFocus
            />
          </Row>
          <Row label={t("log.filterType")}>
            <OptionSelect
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
                ...(mode === "input" ? [{ value: "file", label: t("editor.fieldTypeFile") }] : []),
              ]}
            />
          </Row>
        </div>
        <Row label={t("editor.fieldDescLabel")}>
          <Input
            value={prop.description ?? ""}
            onChange={(e) => setProp(setKeyword(prop, "description", e.target.value || undefined))}
          />
        </Row>
        <CheckboxField
          id={`${ids}-required`}
          label={t("manifest.required")}
          checked={draft.required}
          onCheckedChange={(v) => set({ required: Boolean(v) })}
        />

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
                    <CheckboxField
                      id={`${ids}-multiple`}
                      label={t("editor.fieldMultipleLabel")}
                      checked={kind === "multiple"}
                      onCheckedChange={(v) => setProp(setFileKind(prop, v ? "multiple" : "single"))}
                    />
                    {kind === "multiple" && (
                      <NumberRow
                        label={t("editor.fieldMaxFilesLabel")}
                        keyword="maxItems"
                        prop={prop}
                        onChange={setProp}
                      />
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
                        />
                      </Row>
                    )}
                    <Row label={t("editor.fieldPlaceholderLabel")}>
                      <Input
                        value={draft.placeholder ?? ""}
                        onChange={(e) => set({ placeholder: e.target.value })}
                      />
                    </Row>
                    {enumRow.show && (
                      <Row label={t("editor.fieldEnumLabel")}>
                        <KeywordInput value={enumRow.value} onCommit={enumRow.commit} />
                      </Row>
                    )}
                    {isString && (
                      <>
                        <Row label={t("editor.fieldFormat")}>
                          <OptionSelect
                            value={prop.format || "__none"}
                            onValueChange={(v) =>
                              setProp(setKeyword(prop, "format", v === "__none" ? undefined : v))
                            }
                            options={STRING_FORMATS.map((format) => ({
                              value: format || "__none",
                              label: format || "—",
                            }))}
                          />
                        </Row>
                        <NumberRow
                          label={t("editor.fieldMinLength")}
                          keyword="minLength"
                          prop={prop}
                          onChange={setProp}
                        />
                        <NumberRow
                          label={t("editor.fieldMaxLength")}
                          keyword="maxLength"
                          prop={prop}
                          onChange={setProp}
                        />
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
                        <NumberRow
                          label={t("editor.fieldMin")}
                          keyword="minimum"
                          prop={prop}
                          onChange={setProp}
                        />
                        <NumberRow
                          label={t("editor.fieldMax")}
                          keyword="maximum"
                          prop={prop}
                          onChange={setProp}
                        />
                        <NumberRow
                          label={t("editor.fieldStep")}
                          keyword="multipleOf"
                          prop={prop}
                          onChange={setProp}
                        />
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
  children: React.ReactElement;
}) {
  const id = useId();
  return (
    <FormItem id={id} label={label} error={error ?? undefined}>
      {children}
    </FormItem>
  );
}

function NumberRow({
  label,
  keyword,
  prop,
  onChange,
}: {
  label: string;
  keyword: NumericKeyword;
  prop: JSONSchema7;
  onChange: (prop: JSONSchema7) => void;
}) {
  return (
    <Row label={label}>
      <NumberKeywordInput prop={prop} keyword={keyword} onChange={onChange} />
    </Row>
  );
}
