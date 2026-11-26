// SPDX-License-Identifier: Apache-2.0

/**
 * Raw JSON block with a copy button. Tool input/output is technical data —
 * showing it verbatim in monospace is clearer (and more honest) than a parsed
 * field table, and guarantees every field is present.
 */

import { CopyButton } from "@appstrate/ui/components/copy-button";

export function JsonView({ value, copyLabel }: { value: unknown; copyLabel: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <CopyButton value={text} label={copyLabel} className="absolute top-1 right-1" />
      <pre className="overflow-x-auto rounded bg-black/5 p-3 pr-9 text-xs whitespace-pre-wrap dark:bg-white/5">
        {text}
      </pre>
    </div>
  );
}
