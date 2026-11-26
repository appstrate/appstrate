// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call's detail, wherever it is opened: the card's dialog in the thread and the call's view
 * in the context panel. Its input, its output, its error, and the card's metadata, each as raw
 * JSON; a section with nothing in it is left out (`undefined`, `null`, `""`, `{}`, `[]`).
 *
 * `t` is passed, not read from the chat's host: the context panel is drawn outside the chat.
 */

import type { ChatTranslate } from "./runtime-context.ts";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { JsonView } from "./json-view.tsx";

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const rec = asRecordOrNull(value);
  if (rec) return Object.keys(rec).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function DetailSection({ title, value, t }: { title: string; value: unknown; t: ChatTranslate }) {
  if (!hasContent(value)) return null;
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-muted-foreground text-[0.65rem] font-semibold tracking-wide uppercase">
        {title}
      </h4>
      <JsonView value={value} copyLabel={t("common:btn.copy")} />
    </section>
  );
}

export function ToolCallDetail({
  t,
  input,
  output,
  error,
  metadata,
}: {
  t: ChatTranslate;
  /** The call's arguments. */
  input: unknown;
  /** Its result, unwrapped (`unwrapMcpResult`). */
  output: unknown;
  /** What a failed call says. */
  error?: string | undefined;
  /** The card's own facts about the call (its id, HTTP status, duration). */
  metadata?: Record<string, unknown> | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DetailSection title={t("tool.detail.input")} value={input} t={t} />
      <DetailSection title={t("tool.detail.output")} value={output} t={t} />
      <DetailSection title={t("tool.detail.error")} value={error} t={t} />
      <DetailSection title={t("tool.detail.metadata")} value={metadata} t={t} />
    </div>
  );
}
