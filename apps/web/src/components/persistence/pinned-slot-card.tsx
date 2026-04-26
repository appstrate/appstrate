// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Pin, Trash2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { formatDateField } from "../../lib/markdown";
import { ActorBadge } from "./actor-badge";

const CHECKPOINT_KEY = "checkpoint";
const STRING_PREVIEW_LIMIT = 160;

export interface PinnedSlotCardProps {
  slot: {
    id: number;
    key: string;
    content: unknown;
    actorType: PersistenceActorType;
    actorId: string | null;
    runId: string | null;
    updatedAt: string | null;
  };
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
}

/**
 * One pinned slot — header (key tag + scope + timestamp + actions),
 * collapsed-by-default body with an inline preview. Strings render as
 * text; objects/arrays show a compact `{ k1: "v1", … 4 more }` summary
 * when collapsed, full `JsonView` when expanded. The `checkpoint` key
 * gets a "carry-over" annotation to signal its prompt-injection role.
 */
export function PinnedSlotCard({ slot, onDelete, isDeleting }: PinnedSlotCardProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isCheckpoint = slot.key === CHECKPOINT_KEY;
  const isString = typeof slot.content === "string";
  const isStructured = !isString && slot.content !== null && typeof slot.content === "object";

  // Always-visible preview (string truncation or structured summary).
  const preview = useMemo(() => {
    if (isString) {
      const s = slot.content as string;
      return s.length > STRING_PREVIEW_LIMIT ? s.slice(0, STRING_PREVIEW_LIMIT) + "…" : s;
    }
    if (isStructured) return summarize(slot.content);
    if (slot.content === null) return "null";
    return String(slot.content);
  }, [slot.content, isString, isStructured]);

  // Default expanded for short strings; collapsed for everything else.
  const shouldDefaultExpand = isString && (slot.content as string).length <= STRING_PREVIEW_LIMIT;
  const [expanded, setExpanded] = useState(shouldDefaultExpand);
  const showToggle = !shouldDefaultExpand;

  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    const text = isString ? (slot.content as string) : JSON.stringify(slot.content, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`bg-card overflow-hidden rounded-md border ${
        isCheckpoint
          ? "border-primary/30 border-l-primary border-l-2"
          : "border-border border-l-2 border-l-emerald-500/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Pin
          className={`h-3.5 w-3.5 shrink-0 ${isCheckpoint ? "text-primary" : "text-emerald-500"}`}
          aria-hidden
        />
        <code
          className={`rounded px-1.5 py-0.5 font-mono text-xs font-medium ${
            isCheckpoint ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-500"
          }`}
        >
          {slot.key}
        </code>
        {isCheckpoint && (
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
            {t("detail.pinnedCheckpointHint")}
          </span>
        )}
        <ActorBadge actorType={slot.actorType} actorId={slot.actorId} />
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {slot.updatedAt ? formatDateField(slot.updatedAt) : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-7 w-7"
            onClick={onCopy}
            title={t("btn.copy", { ns: "common" })}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7"
              onClick={() => onDelete(slot.id)}
              disabled={isDeleting}
              title={t("btn.delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="border-border/60 border-t">
        {!expanded ? (
          <button
            type="button"
            onClick={() => showToggle && setExpanded(true)}
            disabled={!showToggle}
            className={`group flex w-full items-start gap-2 px-3 py-2.5 text-left ${
              showToggle ? "hover:bg-muted/40" : ""
            }`}
          >
            <p
              className={`flex-1 truncate ${
                isString
                  ? "text-foreground text-sm whitespace-pre-wrap"
                  : "text-muted-foreground font-mono text-xs"
              }`}
            >
              {preview}
            </p>
            {showToggle && (
              <ChevronDown className="text-muted-foreground group-hover:text-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        ) : (
          <div className="px-3 py-2.5">
            {isString ? (
              <p className="text-foreground text-sm whitespace-pre-wrap">
                {slot.content as string}
              </p>
            ) : isStructured ? (
              <pre className="bg-muted/40 text-foreground/90 max-h-[400px] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {JSON.stringify(slot.content, null, 2)}
              </pre>
            ) : (
              <p className="text-muted-foreground font-mono text-xs">{String(slot.content)}</p>
            )}
            {showToggle && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs"
              >
                <ChevronDown className="h-3 w-3 rotate-180" />
                {t("btn.collapse", { ns: "common" })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact one-line preview for a structured value: shows the first 2-3
 * top-level entries with truncated values, then "+N more". Mirrors what a
 * user wants to see at a glance ("ah, this slot tracks `step`, `notes`,
 * `count`") without exploding the whole tree.
 */
function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    const first = formatScalar(value[0]);
    return value.length === 1 ? `[${first}]` : `[${first}, … +${value.length - 1}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{ }";
    const shown = entries.slice(0, 3).map(([k, v]) => `${k}: ${formatScalar(v)}`);
    const more = entries.length > 3 ? `, … +${entries.length - 3}` : "";
    return `{ ${shown.join(", ")}${more} }`;
  }
  return String(value);
}

function formatScalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    const truncated = v.length > 32 ? v.slice(0, 32) + "…" : v;
    return `"${truncated}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[…${v.length}]`;
  if (typeof v === "object") return "{…}";
  return String(v);
}
