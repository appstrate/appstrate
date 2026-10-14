// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { JsonView as JsonViewLite, allExpanded, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "./copy-button";

interface JsonViewProps {
  data: unknown;
}

// Use structural classes from the lib (layout, spacing, icons) but override all
// color classes with Tailwind tokens so the viewer adapts to light/dark theme.
const jsonStyles = {
  ...defaultStyles,
  container: `${defaultStyles.container} !bg-transparent`,
  label: `${defaultStyles.label} !text-foreground font-medium`,
  clickableLabel: `${defaultStyles.clickableLabel} !text-foreground font-medium`,
  stringValue: `${defaultStyles.stringValue} !text-success`,
  numberValue: `${defaultStyles.numberValue} !text-primary`,
  booleanValue: `${defaultStyles.booleanValue} !text-primary`,
  nullValue: `${defaultStyles.nullValue} !text-muted-foreground`,
  undefinedValue: `${defaultStyles.undefinedValue} !text-muted-foreground`,
  otherValue: `${defaultStyles.otherValue} !text-muted-foreground`,
  punctuation: `${defaultStyles.punctuation} !text-muted-foreground`,
  collapseIcon: `${defaultStyles.collapseIcon} !text-muted-foreground`,
  expandIcon: `${defaultStyles.expandIcon} !text-muted-foreground`,
  collapsedContent: `${defaultStyles.collapsedContent} !text-muted-foreground`,
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
};

export function JsonView({ data }: JsonViewProps) {
  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton value={jsonString} />
      </div>
      <div className="max-h-[500px] overflow-auto font-mono text-sm">
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
