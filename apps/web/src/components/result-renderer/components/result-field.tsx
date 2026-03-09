import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown, InlineMarkdown } from "@/components/markdown";
import { formatDateField } from "@/lib/markdown";
import { detectValueType, type DetectedType } from "@/lib/value-detection";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { ResultArray } from "./result-array";
import { ResultNestedObject } from "./result-nested-object";

const MAX_DEPTH = 6;

interface ResultFieldProps {
  label: string;
  value: unknown;
  fieldKey?: string;
  schemaType?: string;
  depth?: number;
}

function InlineValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-xs text-muted-foreground">
      <strong>{label}:</strong> {children}
    </div>
  );
}

function MarkdownBlock({ label, raw }: { label: string; raw: string }) {
  const { t } = useTranslation("flows");
  const [expanded, setExpanded] = useState(raw.length <= 200);

  return (
    <div className="mt-1.5 text-sm">
      <strong className="text-foreground">{label}</strong>
      <div className="relative">
        <Markdown
          className={cn("mt-1 max-w-none leading-relaxed", !expanded && "max-h-24 overflow-hidden")}
        >
          {raw}
        </Markdown>
        {raw.length > 200 && (
          <button
            className="text-xs text-primary hover:underline mt-1"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? t("result.showLess") : t("result.showMore")}
          </button>
        )}
        {expanded && raw.length > 200 && (
          <CopyButton text={raw} className="absolute right-0 top-0" />
        )}
      </div>
    </div>
  );
}

export function ResultField({ label, value, fieldKey, schemaType, depth = 0 }: ResultFieldProps) {
  const { t } = useTranslation("flows");

  if (value === undefined || value === null) {
    return (
      <InlineValue label={label}>
        <em className="text-muted-foreground/60">&mdash;</em>
      </InlineValue>
    );
  }

  // At max depth, render as JSON string
  if (depth >= MAX_DEPTH && (typeof value === "object" || Array.isArray(value))) {
    return (
      <InlineValue label={label}>
        <span className="font-mono text-xs break-all">{JSON.stringify(value)}</span>
      </InlineValue>
    );
  }

  const detected: DetectedType = detectValueType(value, fieldKey, schemaType);

  switch (detected) {
    case "boolean": {
      const boolLabel = value ? t("result.boolYes") : t("result.boolNo");
      return (
        <InlineValue label={label}>
          <span className={cn("font-medium", value ? "text-success" : "text-muted-foreground")}>
            {boolLabel}
          </span>
        </InlineValue>
      );
    }

    case "number":
      return (
        <InlineValue label={label}>
          <span>{String(value)}</span>
        </InlineValue>
      );

    case "date":
      return (
        <InlineValue label={label}>
          <span>{formatDateField(value as string)}</span>
        </InlineValue>
      );

    case "email":
      return (
        <InlineValue label={label}>
          <a href={`mailto:${value}`} className="text-primary hover:underline">
            {String(value)}
          </a>
        </InlineValue>
      );

    case "image-url":
      return (
        <div className="mt-1.5 text-sm">
          <strong className="text-foreground">{label}</strong>
          <img
            src={String(value)}
            alt={label}
            loading="lazy"
            className="mt-1 max-h-64 rounded-md border border-border object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      );

    case "url":
      return (
        <InlineValue label={label}>
          <a
            href={String(value)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline break-all"
          >
            {String(value)}
          </a>
        </InlineValue>
      );

    case "markdown":
      return <MarkdownBlock label={label} raw={String(value)} />;

    case "list":
      return <ResultArray label={label} items={value as unknown[]} depth={depth} />;

    case "object":
      return (
        <ResultNestedObject label={label} data={value as Record<string, unknown>} depth={depth} />
      );

    default: {
      // Short text
      const strVal = String(value);
      if (strVal.length > 80) {
        return <MarkdownBlock label={label} raw={strVal} />;
      }
      return (
        <InlineValue label={label}>
          <InlineMarkdown>{strVal}</InlineMarkdown>
        </InlineValue>
      );
    }
  }
}
