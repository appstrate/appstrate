import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { JsonView } from "@/components/json-view";
import { CopyButton } from "./components/copy-button";

interface ResultRendererProps {
  data?: Record<string, unknown>;
}

/**
 * Detect if data contains a single string value that looks like markdown content.
 * This enables nice rendering for flows that return e.g. `{ report: "# Title\n..." }`.
 */
function detectMarkdown(data: Record<string, unknown>): string | null {
  const values = Object.values(data);
  for (const val of values) {
    if (typeof val === "string" && val.length > 50 && /^#|\n##|\*\*|^-\s/m.test(val)) {
      return val;
    }
  }
  return null;
}

export function ResultRenderer({ data }: ResultRendererProps) {
  const { t } = useTranslation(["flows", "common"]);
  const hasData = data && Object.keys(data).length > 0;

  const markdownContent = useMemo(() => {
    if (!hasData) return null;
    return detectMarkdown(data!);
  }, [data, hasData]);

  const copyText = useMemo(() => {
    if (markdownContent) return markdownContent;
    if (hasData) return JSON.stringify(data, null, 2);
    return "";
  }, [data, hasData, markdownContent]);

  return (
    <div className="mt-4" role="region" aria-label={t("result.title")}>
      <div className="flex items-center gap-1 mb-3">
        <div className="ml-auto" />
        <CopyButton text={copyText} />
      </div>

      {markdownContent ? (
        <Markdown className="max-w-none leading-relaxed text-sm">{markdownContent}</Markdown>
      ) : hasData ? (
        <JsonView data={data!} />
      ) : null}
    </div>
  );
}
