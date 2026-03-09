import { humanizeKey, INTERNAL_FIELDS } from "@/lib/value-detection";
import { ResultSummary } from "./components/result-summary";
import { ResultMetadata } from "./components/result-metadata";
import { ResultField } from "./components/result-field";

interface HeuristicRendererProps {
  data: Record<string, unknown>;
}

export function HeuristicRenderer({ data }: HeuristicRendererProps) {
  // Separate fields by category
  const entries = Object.entries(data).filter(
    ([k, v]) => !INTERNAL_FIELDS.has(k) && v !== null && v !== undefined,
  );

  const hasSummary = typeof data.summary === "string" && data.summary;

  // Non-summary, non-numeric fields
  const contentEntries = entries.filter(([k, v]) => k !== "summary" && typeof v !== "number");

  return (
    <div className="space-y-1">
      {/* Summary rendered as markdown block */}
      {hasSummary && <ResultSummary text={data.summary as string} />}

      {/* Numeric metadata stats line */}
      <ResultMetadata data={data} />

      {/* Remaining fields rendered generically */}
      {contentEntries.map(([key, value]) => (
        <ResultField key={key} label={humanizeKey(key)} value={value} fieldKey={key} />
      ))}
    </div>
  );
}
