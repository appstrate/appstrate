// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { formatDateField } from "../../lib/markdown";
import { ActorBadge } from "./actor-badge";

export interface MemoryRowProps {
  memory: {
    id: number;
    content: unknown;
    actorType: PersistenceActorType;
    actorId: string | null;
    createdAt: string | null;
  };
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
}

/** One memory line — content, scope badge, timestamp, optional delete button. */
export function MemoryRow({ memory, onDelete, isDeleting }: MemoryRowProps) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <div className="border-border flex items-center gap-3 rounded-md border px-3 py-2">
      <span className="text-foreground flex-1 truncate text-sm">
        {typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content)}
      </span>
      <ActorBadge actorType={memory.actorType} actorId={memory.actorId} />
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {memory.createdAt ? formatDateField(memory.createdAt) : ""}
      </span>
      {onDelete && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDelete(memory.id)}
          disabled={isDeleting}
        >
          {t("btn.delete")}
        </Button>
      )}
    </div>
  );
}
