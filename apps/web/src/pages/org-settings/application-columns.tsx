// SPDX-License-Identifier: Apache-2.0

/**
 * The workspaces column set.
 *
 * Same reasoning as `member-columns.tsx`: a workspace row is a record — name,
 * when it was created, whether it is the default, and the gear that opens it —
 * so it belongs in a table where those four are named once at the top rather
 * than in a card that reprints them per row.
 */

import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import type { DataColumn } from "../../components/data-table";
import { formatDateField } from "../../lib/markdown";

export interface ApplicationRow {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

export function useApplicationColumns({
  defaultLabel,
  onOpen,
}: {
  defaultLabel: string;
  onOpen: (applicationId: string) => void;
}): DataColumn<ApplicationRow>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "workspace",
      header: t("applications.nameLabel"),
      width: "minmax(160px,1.6fr)",
      cell: (app) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{app.name}</span>
          {app.isDefault && <Badge variant="running">{defaultLabel}</Badge>}
        </div>
      ),
    },
    {
      id: "created",
      header: t("applications.createdColumn"),
      width: "132px",
      align: "end",
      // Tier 2, not 3: the settings dialog tops out around 800px and never
      // crosses the 56rem threshold, so tier 3 there means never drawn.
      tier: 2,
      cell: (app) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(app.createdAt, "date")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (app) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onOpen(app.id)}
          title={t("nav.appSettings", { ns: "common" })}
          aria-label={t("nav.appSettings", { ns: "common" })}
          data-testid={`application-settings-${app.id}`}
        >
          <Settings size={16} />
        </Button>
      ),
    },
  ];
}
