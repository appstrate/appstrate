// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Trash2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { formatDateField } from "../../lib/markdown";
import { ActorBadge } from "./actor-badge";

const PREVIEW_CHAR_LIMIT = 220;

export interface MemoryRowProps {
  memory: {
    id: number;
    content: unknown;
    actorType: PersistenceActorType;
    actorId: string | null;
    pinned?: boolean;
    createdAt: string | null;
  };
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
}

/**
 * One archive memory row — full-text rendering with expand-on-overflow,
 * scope badge, timestamp, optional delete button. JSON content is rendered
 * compactly inline; strings get a full text block.
 */
export function MemoryRow({ memory, onDelete, isDeleting }: MemoryRowProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [expanded, setExpanded] = useState(false);

  const isString = typeof memory.content === "string";
  const fullText = isString ? (memory.content as string) : JSON.stringify(memory.content, null, 2);
  const isLong = fullText.length > PREVIEW_CHAR_LIMIT;
  const display = isLong && !expanded ? fullText.slice(0, PREVIEW_CHAR_LIMIT) + "…" : fullText;

  return (
    <div className="border-border bg-card hover:border-border/80 group rounded-md border transition-colors">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <FileText className="text-muted-foreground/60 mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p
            className={`text-foreground text-sm whitespace-pre-wrap ${
              isString ? "" : "font-mono text-xs"
            }`}
          >
            {display}
          </p>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-xs"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
              {expanded ? t("btn.collapse", { ns: "common" }) : t("btn.expand", { ns: "common" })}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ActorBadge actorType={memory.actorType} actorId={memory.actorId} />
          <span className="text-muted-foreground text-xs whitespace-nowrap">
            {memory.createdAt ? formatDateField(memory.createdAt) : ""}
          </span>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => onDelete(memory.id)}
              disabled={isDeleting}
              title={t("btn.delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
