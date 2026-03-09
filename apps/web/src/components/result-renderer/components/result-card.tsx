import { extractTitle, humanizeKey, isDateString, TITLE_KEYS } from "@/lib/value-detection";
import { formatDateField } from "@/lib/markdown";
import { ResultField } from "./result-field";

interface ResultCardProps {
  item: Record<string, unknown>;
  depth?: number;
}

const TITLE_KEYS_SET = new Set(TITLE_KEYS);

export function ResultCard({ item, depth = 0 }: ResultCardProps) {
  const title = extractTitle(item);
  const startDate = item.start ? formatDateField(item.start as string) : "";
  const endDate = item.end ? formatDateField(item.end as string) : "";

  const skipFields = new Set([...TITLE_KEYS_SET, "start", "end", "location", "event_id"]);

  const remainingEntries = Object.entries(item).filter(
    ([k, v]) => !skipFields.has(k) && v !== null && v !== undefined && v !== "",
  );

  return (
    <div className="border border-border rounded-md p-3 space-y-1">
      {title && (
        <div className="flex items-center gap-2">
          <strong className="text-sm">{title}</strong>
        </div>
      )}
      {startDate && (
        <div className="text-xs text-muted-foreground flex gap-1.5">
          <span>{startDate}</span>
          {endDate && <span>— {endDate}</span>}
          {typeof item.location === "string" && item.location && (
            <span>
              · {item.location.length > 50 ? item.location.slice(0, 50) + "..." : item.location}
            </span>
          )}
        </div>
      )}
      {remainingEntries.map(([key, val]) => {
        // Inline date rendering for detected date fields
        if (typeof val === "string" && isDateString(val)) {
          return (
            <div key={key} className="text-xs text-muted-foreground">
              <strong>{humanizeKey(key)}:</strong> {formatDateField(val)}
            </div>
          );
        }
        return (
          <ResultField
            key={key}
            label={humanizeKey(key)}
            value={val}
            fieldKey={key}
            depth={depth + 1}
          />
        );
      })}
    </div>
  );
}
