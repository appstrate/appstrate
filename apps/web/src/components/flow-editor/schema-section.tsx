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
import { toSlug, toLiveSlug } from "../../lib/strings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SchemaField {
  _id: string;
  key: string;
  type: string;
  description: string;
  required: boolean;
  placeholder?: string;
  default?: string;
  enumValues?: string;
  format?: string;
  accept?: string;
  maxSize?: string;
  multiple?: boolean;
  maxFiles?: string;
}

type SchemaMode = "input" | "output" | "config" | "credentials";

interface SchemaSectionProps {
  title: string;
  mode: SchemaMode;
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
  readOnly?: boolean;
}

const TYPE_OPTIONS = ["string", "number", "boolean", "array", "object"];
const INPUT_TYPE_OPTIONS = [...TYPE_OPTIONS, "file"];

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
  const { t } = useTranslation(["flows", "common"]);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: field._id,
    disabled: readOnly,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const isFile = mode === "input" && field.type === "file";
  const typeOptions = mode === "input" ? INPUT_TYPE_OPTIONS : TYPE_OPTIONS;
  const showDetails = hasDetailsRow(mode);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-border rounded-md p-2.5 mb-2 bg-card [&[style*='transform']]:shadow-lg [&[style*='transform']]:z-10"
    >
      <div className="flex items-center gap-2">
        {!readOnly && (
          <span
            className="cursor-grab text-muted-foreground select-none text-base leading-none hover:text-foreground active:cursor-grabbing"
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
          onChange={(e) => onUpdate(index, { key: toLiveSlug(e.target.value) })}
          onBlur={() => onUpdate(index, { key: toSlug(field.key) })}
          className="w-[120px] min-w-0 shrink-0 h-7 text-xs font-mono"
          disabled={readOnly}
        />
        <Select
          value={field.type}
          onValueChange={(v) => onUpdate(index, { type: v })}
          disabled={readOnly}
        >
          <SelectTrigger className="h-7 w-[100px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => (
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
          className="flex-1 min-w-0 h-7 text-xs"
          disabled={readOnly}
        />
        <Label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap cursor-pointer font-normal">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onUpdate(index, { required: e.target.checked })}
            disabled={readOnly}
            className="w-3.5 h-3.5 rounded"
          />
          {t("editor.fieldReq")}
        </Label>
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(index)}
          >
            &times;
          </Button>
        )}
      </div>
      {showDetails && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {isFile ? (
            <>
              <Input
                type="text"
                placeholder={t("editor.fieldAccept")}
                value={field.accept ?? ""}
                onChange={(e) => onUpdate(index, { accept: e.target.value })}
                className="flex-1 min-w-[100px] h-7 text-xs"
              />
              <Input
                type="text"
                placeholder={t("editor.fieldMaxSize")}
                value={field.maxSize ?? ""}
                onChange={(e) => onUpdate(index, { maxSize: e.target.value })}
                className="flex-1 min-w-[100px] h-7 text-xs"
              />
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap cursor-pointer font-normal">
                <input
                  type="checkbox"
                  checked={field.multiple ?? false}
                  onChange={(e) => onUpdate(index, { multiple: e.target.checked })}
                  className="w-3.5 h-3.5 rounded"
                />
                {t("editor.fieldMultiple")}
              </Label>
              {field.multiple && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldMaxFiles")}
                  value={field.maxFiles ?? ""}
                  onChange={(e) => onUpdate(index, { maxFiles: e.target.value })}
                  className="flex-1 min-w-[100px] h-7 text-xs"
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
                  className="flex-1 min-w-[100px] h-7 text-xs"
                />
              )}
              {mode === "input" && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldPlaceholder")}
                  value={field.placeholder ?? ""}
                  onChange={(e) => onUpdate(index, { placeholder: e.target.value })}
                  className="flex-1 min-w-[100px] h-7 text-xs"
                />
              )}
              {mode === "config" && (
                <Input
                  type="text"
                  placeholder={t("editor.fieldEnum")}
                  value={field.enumValues ?? ""}
                  onChange={(e) => onUpdate(index, { enumValues: e.target.value })}
                  className="flex-1 min-w-[100px] h-7 text-xs"
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
  const { t } = useTranslation(["flows", "common"]);
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
    <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
      <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border">
        {title}
      </div>
      <div className="space-y-3 p-4">
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
            className="border-dashed text-muted-foreground hover:text-foreground"
            onClick={add}
          >
            {t("editor.addField")}
          </Button>
        )}
      </div>
    </div>
  );
}
