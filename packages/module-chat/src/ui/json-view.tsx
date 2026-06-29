// SPDX-License-Identifier: Apache-2.0

/**
 * Raw JSON block with a copy button. Tool input/output is technical data —
 * showing it verbatim in monospace is clearer (and more honest) than a parsed
 * field table, and guarantees every field is present.
 */

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

export function JsonView({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Copier"
        className="text-muted-foreground hover:text-foreground absolute top-2 right-2"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
      <pre className="overflow-x-auto rounded bg-black/5 p-3 pr-9 text-xs whitespace-pre-wrap dark:bg-white/5">
        {text}
      </pre>
    </div>
  );
}
