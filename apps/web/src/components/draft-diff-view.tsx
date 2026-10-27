// SPDX-License-Identifier: Apache-2.0

import { CodeDiff } from "./monaco";

interface DraftDiffViewProps {
  original: string;
  modified: string;
  language?: string;
  originalLabel?: string;
  modifiedLabel?: string;
}

export function DraftDiffView({
  original,
  modified,
  language = "plaintext",
  originalLabel,
  modifiedLabel,
}: DraftDiffViewProps) {
  return (
    <div>
      {(originalLabel || modifiedLabel) && (
        <div className="border-border mb-0 flex border-b">
          <div className="text-muted-foreground flex-1 px-3 py-1.5 text-xs font-medium">
            {originalLabel}
          </div>
          <div className="text-muted-foreground flex-1 px-3 py-1.5 text-xs font-medium">
            {modifiedLabel}
          </div>
        </div>
      )}
      <CodeDiff height="400px" language={language} original={original} modified={modified} />
    </div>
  );
}
