// SPDX-License-Identifier: Apache-2.0

/**
 * The organization's spaces, as one table.
 *
 * Main (#1437) added two kinds of row that did not exist before: a member's
 * PERSONAL space, and a personal space that has been ORPHANED — its owner left
 * the organization, a 30-day window is running, and an owner or admin decides
 * between converting it to a team space and sweeping it (RBAC spec §3.6).
 *
 * Main renders the second kind as a separate section of cards with two buttons
 * on each. Here they are rows like the others: the state is a column, and the
 * two acts join the row's own Actions menu, because a list on this surface is
 * a table and a row carries one menu. Neither act is reversible, so both still
 * go through a confirmation.
 */

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow, Plus } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useConvertSpaceToTeam, useSpaces, useSweepPersonalSpace } from "../../hooks/use-spaces";
import { usePermissions } from "../../hooks/use-permissions";
import { useSpaceSwitcher } from "../../hooks/use-current-space";
import { ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { ConfirmModal } from "../../components/confirm-modal";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { useSpaceColumns } from "./space-columns";
import { SpaceCreateModal } from "../../components/space-create-modal";
import { getErrorMessage } from "@appstrate/core/errors";

export function OrgSettingsSpacesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: spaces, isLoading, error } = useSpaces();
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<{ id: string; action: "convert" | "sweep" } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { switchSpace } = useSpaceSwitcher();
  const { can } = usePermissions();
  const convert = useConvertSpaceToTeam();
  const sweep = useSweepPersonalSpace();
  const busy = convert.isPending || sweep.isPending;

  const handleSpaceClick = (spaceId: string) => {
    switchSpace(spaceId);
    navigate("/workspace-settings/general", { state: location.state });
  };

  const runPending = () => {
    if (!pending) return;
    const params = { params: { path: { id: pending.id } } };
    if (pending.action === "convert") {
      convert.mutate(params, {
        onSuccess: () => {
          setPending(null);
          toast.success(t("spaces.personal.converted"));
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      });
      return;
    }
    sweep.mutate(params, {
      onSuccess: (result) => {
        setPending(null);
        toast.success(
          t("spaces.personal.swept", {
            rehomed: result.rehomed_packages,
            deleted: result.deleted_packages,
          }),
        );
      },
      onError: (err) => toast.error(getErrorMessage(err)),
    });
  };

  const columns = useSpaceColumns({
    defaultLabel: t("spaces.default"),
    onOpen: handleSpaceClick,
    // Only an orphaned space offers them, and only to whoever may write spaces.
    onConvert: can("spaces:write") ? (id) => setPending({ id, action: "convert" }) : undefined,
    onSweep: can("spaces:write") ? (id) => setPending({ id, action: "sweep" }) : undefined,
    actionsBusy: busy,
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

      <ConfirmModal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          pending?.action === "sweep"
            ? t("spaces.personal.sweepConfirm")
            : t("spaces.personal.convertConfirm")
        }
        variant={pending?.action === "sweep" ? "destructive" : "default"}
        isPending={busy}
        onConfirm={runPending}
      />
    </>
  );
}
