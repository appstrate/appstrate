import { useMemo } from "react";
import { JsonView as JsonViewLite, allExpanded } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "./result-renderer/components/copy-button";

interface JsonViewProps {
  data: unknown;
}

const jsonStyles = {
  container: "json-view-container",
  basicChildStyle: "json-view-row",
  childFieldsContainer: "",
  label: "text-foreground font-medium",
  clickableLabel: "text-foreground font-medium cursor-pointer",
  stringValue: "text-success",
  numberValue: "text-primary",
  booleanValue: "text-primary",
  nullValue: "text-muted-foreground",
  undefinedValue: "text-muted-foreground",
  otherValue: "text-muted-foreground",
  punctuation: "text-muted-foreground",
  collapseIcon: "text-muted-foreground",
  expandIcon: "text-muted-foreground",
  collapsedContent: "text-muted-foreground",
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
};

export function JsonView({ data }: JsonViewProps) {
  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton text={jsonString} />
      </div>
      <div className="font-mono text-sm bg-card border border-border rounded-lg p-4 overflow-auto max-h-[500px]">
        <JsonViewLite
          data={data as Record<string, unknown>}
          shouldExpandNode={allExpanded}
          style={jsonStyles}
          clickToExpandNode
        />
      </div>
    </div>
  );
}
