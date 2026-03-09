import { humanizeKey } from "@/lib/value-detection";
import { CollapsibleSection } from "./collapsible-section";
import { ResultField } from "./result-field";

interface ResultNestedObjectProps {
  label: string;
  data: Record<string, unknown>;
  depth?: number;
}

export function ResultNestedObject({ label, data, depth = 0 }: ResultNestedObjectProps) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);

  if (entries.length === 0) return null;

  return (
    <CollapsibleSection title={label} count={entries.length}>
      <div className="space-y-1">
        {entries.map(([key, val]) => (
          <ResultField
            key={key}
            label={humanizeKey(key)}
            value={val}
            fieldKey={key}
            depth={depth + 1}
          />
        ))}
      </div>
    </CollapsibleSection>
  );
}
