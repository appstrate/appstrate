// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { formatDateField } from "../../lib/markdown";
import { JsonView } from "../json-view";
import { ActorBadge } from "./actor-badge";

export interface CheckpointCardProps {
  checkpoint: {
    id: number;
    content: unknown;
    actorType: PersistenceActorType;
    actorId: string | null;
    runId: string | null;
    updatedAt: string | null;
  };
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
}

/** A single checkpoint — header (scope + timestamp), JSON content, optional delete button. */
export function CheckpointCard({ checkpoint, onDelete, isDeleting }: CheckpointCardProps) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <ActorBadge actorType={checkpoint.actorType} actorId={checkpoint.actorId} />
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {checkpoint.updatedAt ? formatDateField(checkpoint.updatedAt) : ""}
        </span>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => onDelete(checkpoint.id)}
            disabled={isDeleting}
          >
            {t("btn.delete")}
          </Button>
        )}
      </div>
      <JsonView data={checkpoint.content as Record<string, unknown>} />
    </div>
  );
}
