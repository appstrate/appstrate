import { useTranslation } from "react-i18next";
import { humanizeKey, INTERNAL_FIELDS } from "@/lib/value-detection";

interface ResultMetadataProps {
  data: Record<string, unknown>;
}

const METADATA_SKIP_FIELDS = new Set([...INTERNAL_FIELDS, "summary"]);

export function ResultMetadata({ data }: ResultMetadataProps) {
  const { t } = useTranslation("flows");

  // Collect top-level numeric fields (excluding internal ones)
  const numericParts: { label: string; value: number }[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (METADATA_SKIP_FIELDS.has(key)) continue;
    if (typeof val !== "number") continue;

    // Try i18n key first (e.g., result.emailsProcessed), fallback to humanized key
    const i18nKey = `result.${key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
    const translated = t(i18nKey, { count: val });
    const label = translated !== i18nKey ? translated : `${val} ${humanizeKey(key).toLowerCase()}`;

    numericParts.push({ label, value: val });
  }

  if (numericParts.length === 0) return null;

  return (
    <p className="text-xs text-muted-foreground mb-3">
      {numericParts.map((p) => p.label).join(" — ")}
    </p>
  );
}
