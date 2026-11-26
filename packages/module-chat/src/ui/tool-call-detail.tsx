// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call's detail, in the card's dialog and in the context panel; an empty section is left
 * out. `t` is passed: the context panel is drawn outside the chat's host.
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

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-muted-foreground text-[0.65rem] font-semibold tracking-wide uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

function JsonSection({ title, value, t }: { title: string; value: unknown; t: ChatTranslate }) {
  if (!hasContent(value)) return null;
  return (
    <DetailSection title={title}>
      <JsonView value={value} copyLabel={t("common:btn.copy")} />
    </DetailSection>
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
  input: unknown;
  /** Unwrapped (`unwrapMcpResult`). */
  output: unknown;
  error?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <JsonSection title={t("tool.detail.input")} value={input} t={t} />
      <JsonSection title={t("tool.detail.output")} value={output} t={t} />
      {error ? (
        <DetailSection title={t("tool.detail.error")}>
          <p className="text-destructive text-xs break-words whitespace-pre-wrap">{error}</p>
        </DetailSection>
      ) : null}
      <JsonSection title={t("tool.detail.metadata")} value={metadata} t={t} />
    </div>
  );
}
