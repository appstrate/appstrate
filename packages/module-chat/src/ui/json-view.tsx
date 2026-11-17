// SPDX-License-Identifier: Apache-2.0

/**
 * Raw JSON block with a copy button. Tool input/output is technical data —
 * showing it verbatim in monospace is clearer (and more honest) than a parsed
 * field table, and guarantees every field is present.
 */

import { CopyButton } from "@appstrate/ui/components/copy-button";
import { useChatHost } from "./runtime-context.ts";

export function JsonView({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const { t } = useChatHost();

  return (
    <div className="relative">
      <CopyButton
        value={text}
        label={t("common:btn.copy")}
        className="absolute top-1 right-1 size-7"
      />
      <pre className="overflow-x-auto rounded bg-black/5 p-3 pr-9 text-xs whitespace-pre-wrap dark:bg-white/5">
        {text}
      </pre>
    </div>
  );
}
