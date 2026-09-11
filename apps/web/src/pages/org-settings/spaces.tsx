// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppWindow, Plus } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useSpaces } from "../../hooks/use-spaces";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceSwitcher } from "../../hooks/use-current-space";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { useSpaceColumns } from "./space-columns";
import { SpaceCreateModal } from "../../components/space-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsSpacesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: spaces, isLoading, error } = useSpaces();
  const [createOpen, setCreateOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { switchSpace } = useSpaceSwitcher();
  const { can } = usePermissions();

  const handleSpaceClick = (spaceId: string) => {
    switchSpace(spaceId);
    navigate("/workspace-settings/general", { state: location.state });
  };

  const columns = useSpaceColumns({
    defaultLabel: t("spaces.default"),
    onOpen: handleSpaceClick,
  });

  // Reading is the route's gate (`spaces:read`); creating is its own permission.
  return (
    <>
      {can("spaces:write") && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem
              data-page-action="create"
              data-testid="create-space-button"
              onSelect={() => setCreateOpen(true)}
            >
              <Plus />
              {t("spaces.create")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <DataTable
        label={t("spaces.pageTitle")}
        columns={columns}
        rows={spaces ?? []}
        rowKey={(space) => space.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          // No action of its own: the button above is the same one.
          <EmptyState message={t("spaces.empty")} hint={t("spaces.emptyHint")} icon={AppWindow} />
        }
      />

      <SpaceCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
