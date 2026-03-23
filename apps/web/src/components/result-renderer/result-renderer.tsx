import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { JsonView } from "@/components/json-view";
import { CopyButton } from "./components/copy-button";

interface ResultRendererProps {
  report?: string;
  data?: Record<string, unknown>;
  reportStreaming?: boolean;
}

export function ResultRenderer({ report, data, reportStreaming }: ResultRendererProps) {
  const { t } = useTranslation(["flows", "common"]);

  const hasReport = !!report;
  const hasData = data && Object.keys(data).length > 0;

  const copyText = useMemo(() => {
    if (hasReport) return report;
    if (hasData) return JSON.stringify(data, null, 2);
    return "";
  }, [report, data, hasReport, hasData]);

  return (
    <div className="mt-4" role="region" aria-label={t("result.title")}>
      <div className="flex items-center gap-1 mb-3">
        <div className="ml-auto" />
        <CopyButton text={copyText} />
      </div>

      {hasReport && (
        <>
          <Markdown className="max-w-none leading-relaxed text-sm">{report!}</Markdown>
          {reportStreaming && (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </div>
          )}
        </>
      )}
      {hasData && <JsonView data={data!} />}
    </div>
  );
}
