// SPDX-License-Identifier: Apache-2.0

/**
 * A run's structured output read as facts: one label above one value, in the
 * fact-grid shape of the manifest view (`manifest-fact.tsx`). The label is the
 * field's `title` in the agent's output schema, and its `description` sits
 * under the value; a field the schema does not describe keeps its key. Schema
 * fields come first, in schema order, then whatever else the run returned.
 *
 * Deliberately shallow: a nested object or array of objects is shown as
 * indented JSON inside its cell. The raw JSON of the whole output stays one
 * toggle away at every call site, so nothing is ever hidden here.
 */

import { cn } from "../cn.ts";

interface FieldDoc {
  title?: string;
  description?: string;
}

/** The documented properties of a JSON schema, read defensively (schemas are agent-authored). */
function schemaFields(schema: unknown): Record<string, FieldDoc> {
  if (!schema || typeof schema !== "object") return {};
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return {};
  const out: Record<string, FieldDoc> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object") continue;
    const { title, description } = raw as { title?: unknown; description?: unknown };
    out[key] = {
      title: typeof title === "string" && title ? title : undefined,
      description: typeof description === "string" && description ? description : undefined,
    };
  }
  return out;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function FactValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="whitespace-pre-wrap">{value}</span>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  if (Array.isArray(value) && value.every(isPrimitive)) return <span>{value.join(", ")}</span>;
  if (isPrimitive(value)) return <code className="font-mono text-xs">{String(value)}</code>;
  return (
    <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function StructuredOutput({
  value,
  schema,
  className,
}: {
  value: Record<string, unknown>;
  /** The agent's output JSON schema, when known. */
  schema?: unknown;
  className?: string;
}) {
  const fields = schemaFields(schema);
  const keys = [
    ...Object.keys(fields).filter((key) => key in value),
    ...Object.keys(value).filter((key) => !(key in fields)),
  ];
  return (
    <dl className={cn("grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2", className)}>
      {keys.map((key) => (
        <div key={key} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{fields[key]?.title ?? key}</dt>
          <dd className="text-foreground mt-1 text-sm break-words">
            <FactValue value={value[key]} />
            {fields[key]?.description && (
              <p className="text-muted-foreground mt-1 text-xs">{fields[key].description}</p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
