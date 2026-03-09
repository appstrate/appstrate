import type { JSONSchemaObject } from "@appstrate/shared-types";
import { humanizeKey, INTERNAL_FIELDS } from "@/lib/value-detection";
import { ResultSummary } from "./components/result-summary";
import { ResultMetadata } from "./components/result-metadata";
import { ResultField } from "./components/result-field";

interface SchemaRendererProps {
  data: Record<string, unknown>;
  schema: JSONSchemaObject;
}

export function SchemaRenderer({ data, schema }: SchemaRendererProps) {
  const schemaKeys = new Set(Object.keys(schema.properties));

  // Extra fields not in schema (excluding internal and numeric metadata already shown)
  const extraEntries = Object.entries(data).filter(
    ([k, v]) =>
      !schemaKeys.has(k) &&
      !INTERNAL_FIELDS.has(k) &&
      typeof v !== "number" &&
      v !== null &&
      v !== undefined,
  );

  return (
    <div className="space-y-1">
      {/* Summary first if present */}
      {schema.properties.summary && typeof data.summary === "string" && (
        <ResultSummary text={data.summary} />
      )}

      {/* Numeric metadata stats line */}
      <ResultMetadata data={data} />

      {/* Schema fields in declared order (skip summary already rendered) */}
      {Object.entries(schema.properties).map(([key, prop]) => {
        if (key === "summary") return null;
        const label = prop.description || humanizeKey(key);
        return (
          <ResultField
            key={key}
            label={label}
            value={data[key]}
            fieldKey={key}
            schemaType={prop.type}
          />
        );
      })}

      {/* Extra fields not in schema */}
      {extraEntries.map(([key, value]) => (
        <ResultField key={key} label={humanizeKey(key)} value={value} fieldKey={key} />
      ))}
    </div>
  );
}
