import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  const [activeView, setActiveView] = useState<"report" | "data">("report");

  const copyText = useMemo(() => {
    if (activeView === "report" && report) return report;
    if (activeView === "data" && hasData) return JSON.stringify(data, null, 2);
    return "";
  }, [activeView, report, data, hasData]);

  return (
    <div className="mt-4" role="region" aria-label={t("result.title")}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-3">
        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as "report" | "data")}>
          <TabsList>
            <TabsTrigger value="report" disabled={!hasReport}>
              {t("result.tabReport")}
            </TabsTrigger>
            <TabsTrigger value="data" disabled={!hasData}>
              {t("result.tabData")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto" />
        <CopyButton text={copyText} />
      </div>

      {/* Content */}
      {activeView === "report" && hasReport && (
        <>
          <Markdown className="max-w-none leading-relaxed text-sm">{report!}</Markdown>
          {reportStreaming && (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </div>
          )}
        </>
      )}
      {activeView === "data" && hasData && <JsonView data={data!} />}
    </div>
  );
}
