// SPDX-License-Identifier: Apache-2.0

/**
 * The organization's spaces as one table. Personal and ORPHANED personal spaces
 * (owner left, 30-day window, convert or sweep: RBAC spec §3.6) are ordinary
 * rows whose acts join the row's Actions menu; both are irreversible, hence confirmed.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow, Plus } from "lucide-react";
import { useConvertSpaceToTeam, useSpaces, useSweepPersonalSpace } from "../../hooks/use-spaces";
import { usePermissions } from "../../hooks/use-permissions";
import { isSpaceEnterable, useSpaceSwitcher } from "../../hooks/use-current-space";
import { spaceLabel } from "../../lib/space-label";
import { EmptyState, EmptyStateAction } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { ConfirmModal } from "../../components/confirm-modal";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import type { MenuAction } from "../../lib/menu-action";
import { useSpaceColumns } from "./space-columns";
import { NEW_SPACE_PARAM, SpaceCreateModal } from "../../components/space-create-modal";
import { useUrlModal } from "../../hooks/use-url-modal";

export function OrgSettingsSpacesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: spaces, isLoading, error } = useSpaces();
  const newSpace = useUrlModal(NEW_SPACE_PARAM);
  const [pending, setPending] = useState<{ id: string; action: "convert" | "sweep" } | null>(null);
  const navigate = useNavigate();
  const { switchSpace } = useSpaceSwitcher();
  const { can } = usePermissions();
  const convert = useConvertSpaceToTeam();
  const sweep = useSweepPersonalSpace();
  const busy = convert.isPending || sweep.isPending;

  const handleSpaceClick = (spaceId: string) => {
    switchSpace(spaceId);
    navigate("/workspace-settings/general");
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
    });
  };

  const columns = useSpaceColumns({
    defaultLabel: t("models.default"),
    // Only an orphaned space offers them, each to the permission its route checks.
    onConvert: can("spaces:write") ? (id) => setPending({ id, action: "convert" }) : undefined,
    onSweep: can("spaces:delete") ? (id) => setPending({ id, action: "sweep" }) : undefined,
    actionsBusy: busy,
  });

  // Reading is the route's gate (`spaces:read`); creating is its own permission.
  const create: MenuAction = {
    id: "create",
    icon: Plus,
    testId: "create-space-button",
    label: t("spaces.create"),
    onSelect: () => newSpace.open(),
    hidden: !can("spaces:write"),
  };

  return (
    <>
      <SettingsPageActions actions={[create]} />

      <DataTable
        label={t("common:switcher.workspacesColumn")}
        columns={columns}
        rows={spaces ?? []}
        rowKey={(space) => space.id}
        rowAction={(space) => handleSpaceClick(space.id)}
        rowActionable={(space) => !space.orphaned_at && isSpaceEnterable(space)}
        rowLabel={(space) => spaceLabel(space, t)}
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState message={t("spaces.empty")} hint={t("spaces.emptyHint")} icon={AppWindow}>
            <EmptyStateAction action={create} />
          </EmptyState>
        }
      />

      {newSpace.value !== null && can("spaces:write") && (
        <SpaceCreateModal onClose={newSpace.close} />
      )}

      <ConfirmModal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t(
          pending?.action === "sweep"
            ? "spaces.personal.sweepTitle"
            : "spaces.personal.convertTitle",
        )}
        confirmLabel={t(
          pending?.action === "sweep" ? "spaces.personal.sweep" : "spaces.personal.convert",
        )}
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
