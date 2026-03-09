import { useTranslation } from "react-i18next";
import { InlineMarkdown } from "@/components/markdown";
import { CollapsibleSection } from "./collapsible-section";
import { ResultCard } from "./result-card";

interface ResultArrayProps {
  label: string;
  items: unknown[];
  depth?: number;
}

export function ResultArray({ label, items, depth = 0 }: ResultArrayProps) {
  const { t } = useTranslation("flows");

  if (items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        <strong>{label}:</strong> <em>{t("result.emptyArray")}</em>
      </div>
    );
  }

  const isObjectArray =
    items.length > 0 &&
    typeof items[0] === "object" &&
    items[0] !== null &&
    !Array.isArray(items[0]);

  return (
    <CollapsibleSection title={label} count={items.length}>
      {isObjectArray ? (
        <div className="flex flex-col gap-2">
          {(items as Record<string, unknown>[]).map((item, i) => (
            <ResultCard key={i} item={item} depth={depth} />
          ))}
        </div>
      ) : (
        <ul className="list-disc pl-5 space-y-0.5 text-sm">
          {items.map((item, i) => (
            <li key={i}>
              {typeof item === "string" ? (
                <InlineMarkdown>{item}</InlineMarkdown>
              ) : (
                <span>{JSON.stringify(item)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
