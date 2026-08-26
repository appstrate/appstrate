// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Settings } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { useSpaces } from "../../hooks/use-spaces";
import { useSpaceSwitcher } from "../../hooks/use-current-space";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { SpaceCreateModal } from "../../components/space-create-modal";
import { formatDateField } from "../../lib/format-date";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsSpacesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: spaces, isLoading, error } = useSpaces();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { switchSpace } = useSpaceSwitcher();

  if (!isAdmin) return null;

  const handleSpaceClick = (spaceId: string) => {
    switchSpace(spaceId);
    navigate("/org-settings/space/general");
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button data-testid="create-space-button" onClick={() => setCreateOpen(true)}>
          {t("spaces.create")}
        </Button>
      </div>

      {!spaces || spaces.length === 0 ? (
        <EmptyState message={t("spaces.empty")} hint={t("spaces.emptyHint")} icon={AppWindow}>
          <Button onClick={() => setCreateOpen(true)}>{t("spaces.create")}</Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {spaces.map((space) => (
            <div
              key={space.id}
              data-testid={`space-card-${space.id}`}
              className="border-border bg-card rounded-lg border p-5"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <h3 className="text-[0.95rem] font-semibold">{space.name}</h3>
                  <span className="text-muted-foreground text-sm">
                    {t("spaces.createdAt", {
                      date: formatDateField(space.createdAt, "date"),
                    })}
                  </span>
                </div>
                {space.isDefault && <Badge variant="running">{t("spaces.default")}</Badge>}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleSpaceClick(space.id)}
                  title={t("nav.spaceSettings", { ns: "common" })}
                >
                  <Settings size={16} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SpaceCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
