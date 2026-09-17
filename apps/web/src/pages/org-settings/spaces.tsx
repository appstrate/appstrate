// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow, Settings } from "lucide-react";
import { usePermissions } from "../../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { ConfirmModal } from "../../components/confirm-modal";
import type { components } from "../../api/client";
import { useConvertSpaceToTeam, useSpaces, useSweepPersonalSpace } from "../../hooks/use-spaces";
import { useSpaceSwitcher } from "../../hooks/use-current-space";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { SpaceCreateModal } from "../../components/space-create-modal";
import { formatDateField } from "../../lib/format-date";
import { spaceLabel } from "../../lib/space-label";
import { getErrorMessage } from "@appstrate/core/errors";

type SpaceObject = components["schemas"]["SpaceObject"];

export function OrgSettingsSpacesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { data: spaces, isLoading, error } = useSpaces();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { switchSpace } = useSpaceSwitcher();

  const handleSpaceClick = (spaceId: string) => {
    switchSpace(spaceId);
    navigate("/org-settings/space/general");
  };

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  const canCreate = can("spaces:write");
  // An ORPHANED personal space is the one a caller sees without being able to
  // enter it: its owner left, and an owner/admin decides between converting it
  // and sweeping it (RBAC spec §3.6). It gets its own section rather than a row
  // in the list, because neither action is the one every other row offers.
  const orphaned = (spaces ?? []).filter((s) => s.personal && !!s.orphaned_at);
  const live = (spaces ?? []).filter((s) => !s.orphaned_at);

  return (
    <>
      {canCreate && (
        <div className="mb-4 flex justify-end">
          <Button data-testid="create-space-button" onClick={() => setCreateOpen(true)}>
            {t("spaces.create")}
          </Button>
        </div>
      )}

      {orphaned.length > 0 && <OrphanedPersonalSpaces spaces={orphaned} />}

      {!spaces || spaces.length === 0 ? (
        <EmptyState message={t("spaces.empty")} hint={t("spaces.emptyHint")} icon={AppWindow}>
          {canCreate && <Button onClick={() => setCreateOpen(true)}>{t("spaces.create")}</Button>}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {live.map((space) => (
            <div
              key={space.id}
              data-testid={`space-card-${space.id}`}
              className="border-border bg-card rounded-lg border p-5"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <h3 className="text-[0.95rem] font-semibold">{spaceLabel(space, t)}</h3>
                  <span className="text-muted-foreground text-sm">
                    {t("spaces.createdAt", {
                      date: formatDateField(space.createdAt, "date"),
                    })}
                  </span>
                </div>
                <Badge variant="secondary">{t(`spaces.visibility.${space.visibility}`)}</Badge>
                {space.isDefault && <Badge variant="running">{t("spaces.default")}</Badge>}
                {space.personal && <Badge variant="secondary">{t("spaces.personal.badge")}</Badge>}
                {/* A `closed` space is listed so the caller knows it exists,
                    not so they can be dropped into it — pinning one 403s every
                    space-scoped request. Same rule as the org switcher. */}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={space.access !== "member"}
                  onClick={() => handleSpaceClick(space.id)}
                  title={
                    space.access === "member"
                      ? t("nav.spaceSettings", { ns: "common" })
                      : t("spaces.requestAccess")
                  }
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

/**
 * Orphaned personal spaces — their owner has left the organization, the 30-day
 * window is running, and an owner or admin has exactly two acts available
 * (RBAC spec §3.6). Neither is reversible, so both go through a confirmation.
 */
function OrphanedPersonalSpaces({ spaces }: { spaces: SpaceObject[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const convert = useConvertSpaceToTeam();
  const sweep = useSweepPersonalSpace();
  const [pending, setPending] = useState<{ id: string; action: "convert" | "sweep" } | null>(null);
  const busy = convert.isPending || sweep.isPending;

  const run = (id: string, action: "convert" | "sweep") => {
    const params = { params: { path: { id } } };
    if (action === "convert") {
      convert.mutate(params, {
        onSuccess: () => {
          setPending(null);
          toast.success(t("spaces.personal.converted"));
        },
        onError: (error) => toast.error(getErrorMessage(error)),
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
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  };

  return (
    <>
      <div className="mb-4">
        <h2 className="text-[0.95rem] font-semibold">{t("spaces.personal.orphanedTitle")}</h2>
        <span className="text-muted-foreground text-sm">{t("spaces.personal.orphanedHint")}</span>
      </div>
      <div className="mb-6 flex flex-col gap-3">
        {spaces.map((space) => (
          <div
            key={space.id}
            data-testid={`orphaned-space-${space.id}`}
            className="border-border bg-card rounded-lg border p-5"
          >
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <div className="flex-1">
                <h3 className="text-[0.95rem] font-semibold">{spaceLabel(space, t)}</h3>
                <span className="text-muted-foreground text-sm">
                  {t("spaces.personal.orphanedSince", {
                    date: formatDateField(space.orphaned_at ?? null, "date"),
                  })}
                </span>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPending({ id: space.id, action: "convert" })}
              >
                {t("spaces.personal.convert")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => setPending({ id: space.id, action: "sweep" })}
              >
                {t("spaces.personal.sweep")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmModal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          pending?.action === "sweep"
            ? t("spaces.personal.sweepConfirm")
            : t("spaces.personal.convertConfirm")
        }
        isPending={busy}
        onConfirm={() => pending && run(pending.id, pending.action)}
      />
    </>
  );
}
