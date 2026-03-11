import { useRef, useCallback, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { SchemaRenderer } from "./schema-renderer";
import { HeuristicRenderer } from "./heuristic-renderer";
import { JsonView } from "@/components/json-view";
import { CopyButton } from "./components/copy-button";

interface ResultRendererProps {
  data: Record<string, unknown>;
  outputSchema?: JSONSchemaObject;
}

export function ResultRenderer({ data, outputSchema }: ResultRendererProps) {
  const { t } = useTranslation(["flows", "common"]);
  const [viewMode, setViewMode] = useState<"formatted" | "json">("formatted");
  const containerRef = useRef<HTMLDivElement>(null);
  const [allExpanded, setAllExpanded] = useState(true);

  const hasSchema = outputSchema?.properties && Object.keys(outputSchema.properties).length > 0;
  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  const toggleAll = useCallback((expand: boolean) => {
    if (!containerRef.current) return;
    const details = containerRef.current.querySelectorAll("details");
    details.forEach((d) => {
      d.open = expand;
    });
    setAllExpanded(expand);
  }, []);

  return (
    <div className="mt-4" role="region" aria-label={t("result.title")}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-3">
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "formatted" | "json")}>
          <TabsList>
            <TabsTrigger value="formatted">{t("result.formatted")}</TabsTrigger>
            <TabsTrigger value="json">{t("result.json")}</TabsTrigger>
          </TabsList>
        </Tabs>

        {viewMode === "formatted" && (
          <>
            <div className="ml-auto" />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => toggleAll(allExpanded === true ? false : true)}
              title={allExpanded === true ? t("result.collapseAll") : t("result.expandAll")}
            >
              {allExpanded === true ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            </Button>
            <CopyButton text={jsonString} />
          </>
        )}
      </div>

      {/* Content */}
      {viewMode === "formatted" ? (
        <div ref={containerRef}>
          <h4 className="text-sm font-semibold mb-2">{t("result.title")}</h4>
          {hasSchema ? (
            <SchemaRenderer data={data} schema={outputSchema!} />
          ) : (
            <HeuristicRenderer data={data} />
          )}
        </div>
      ) : (
        <JsonView data={data} />
      )}
    </div>
  );
}
