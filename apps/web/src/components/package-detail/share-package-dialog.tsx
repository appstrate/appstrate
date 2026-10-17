// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import type { PackageType } from "@appstrate/core/validation";
import { ApiError } from "../../api/errors";
import { Modal } from "../modal";
import { splitPackageRef } from "../../lib/package-paths";
import { useOrgDetail } from "../../hooks/use-org";
import { useSpaces } from "../../hooks/use-spaces";
import { useSpaceGrant } from "../../hooks/use-permissions";
import { isSpaceEnterable, useSpaceSwitcher } from "../../hooks/use-current-space";
import { useCreateVersion, usePackageDetail } from "../../hooks/use-packages";
import { useIntegrationsById } from "../../hooks/use-integrations";
import {
  shareTargetHandle,
  type PackageShare,
  usePackageShares,
  useRevokePackageShare,
  useSharePackage,
} from "../../hooks/use-package-shares";
import { memberLabel } from "../../lib/members";
import { toastError } from "../../lib/mutation-error";
import { TextSkeleton } from "../loading-skeletons";

/** The subject of one offer, as the picker encodes it. */
type ShareTarget = { kind: "user"; userId: string } | { kind: "space"; spaceId: string };

/** One `<SelectItem>` value carrying both halves of a target; the prefix keeps a value from being read as the other kind. */
function targetValue(target: ShareTarget): string {
  return target.kind === "user" ? `user:${target.userId}` : `space:${target.spaceId}`;
}

function parseTargetValue(value: string): ShareTarget | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;
  if (kind === "user") return { kind: "user", userId: id };
  if (kind === "space") return { kind: "space", spaceId: id };
  return null;
}

/** The URL parameter that opens the dialog; its value is the package. */
export const SHARE_PARAM = "share";

/**
 * Distribution only (RBAC §6.10): the package is placed in the recipient's space and runs with
 * THEIR credentials on its latest published version. One picker over people AND spaces (kind is a
 * property of the target, not a second intent). Co-editing is membership of the HOME space, so the
 * dialog only points there.
 */
export function SharePackageDialog({
  onClose,
  packageId,
  type,
  homeSpaceId,
  canPublish,
  onMoveHome,
}: {
  onClose: () => void;
  packageId: string;
  /** Publishing is per-type — the version routes are `/api/packages/<type>/…`. */
  type: PackageType;
  /** The package's home — never a share destination; it already lives there. */
  homeSpaceId: string | null | undefined;
  /** `home_writable`: publishing is a WRITE in the home, which a custom role may withhold from `share` (RBAC §6.10). */
  canPublish: boolean;
  /** Hands over to the move-home dialog (the one way out of a personal space); the caller owns it so two modals never stack. */
  onMoveHome?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: shares, isLoading } = usePackageShares(packageId, true);
  const { data: spaces } = useSpaces();
  const { data: org } = useOrgDetail();
  // Only an AGENT declares integrations.
  const detail = usePackageDetail("agent", type === "agent" ? packageId : undefined);
  const declared = detail.data?.dependencies.integrations ?? [];
  const { data: integrationRows } = useIntegrationsById(declared.map((entry) => entry.id));
  const declaredIntegrations = declared.map((entry) => {
    const row = integrationRows?.find((candidate) => candidate.id === entry.id);
    return row?.manifest.display_name ?? entry.id.split("/").pop() ?? entry.id;
  });
  const share = useSharePackage();
  const revoke = useRevokePackageShare();
  const publish = useCreateVersion(type, packageId);
  const home = useSpaceGrant(homeSpaceId);
  const { switchSpace } = useSpaceSwitcher();
  const [target, setTarget] = useState("");
  /** The offer the server refused for want of a version, kept to replay it. */
  const [needsVersion, setNeedsVersion] = useState<ShareTarget | null>(null);

  /** Already-offered subjects, so the picker does not propose a no-op. */
  const offered = useMemo(() => new Set((shares ?? []).map(shareTargetHandle)), [shares]);

  // The home's OWNER is a no-op target too, but a personal space's owner is not named on the wire,
  // so the picker may offer them; the `409 share_target_is_home` branch below says so.
  const members = (org?.members ?? []).filter((member) => !offered.has(member.userId));
  // Neither the package's home (already has it) nor the caller's own personal space (reached by activating).
  const destinations = (spaces ?? []).filter(
    (candidate) =>
      !candidate.personal &&
      candidate.id !== homeSpaceId &&
      candidate.access === "member" &&
      !offered.has(candidate.id),
  );

  const selected = parseTargetValue(target);
  // The members page edits the CURRENT space, so reaching the home's means standing in it.
  const manageMembers =
    homeSpaceId && home && isSpaceEnterable(home) ? () => switchSpace(homeSpaceId) : undefined;

  const close = () => {
    setTarget("");
    setNeedsVersion(null);
    onClose();
  };

  const submit = (offer: ShareTarget) =>
    share.mutate(
      { params: { path: splitPackageRef(packageId) }, body: { target: offer } },
      {
        onSuccess: () => {
          toast.success(t("packages.shareDone"));
          setTarget("");
          setNeedsVersion(null);
        },
        onError: (error) => {
          // A missing step, performed by the next panel; every other refusal is a toast.
          if (error instanceof ApiError && error.code === "package_has_no_version") {
            setNeedsVersion(offer);
            return;
          }
          // The picker cannot always rule this target out beforehand (another member's personal space is unknown to it).
          if (error instanceof ApiError && error.code === "share_target_is_home") {
            toast.error(t("packages.shareTargetIsHome"));
            return;
          }
          toastError(error);
        },
      },
    );

  /** Publish the draft, then replay the refused offer; the server never publishes on its own (freezing a working copy is the author's call). */
  const publishAndShare = async () => {
    const offer = needsVersion;
    if (!offer) return;
    try {
      const created = await publish.mutateAsync({});
      toast.success(t("packages.sharePublished", { version: created.version }));
      setNeedsVersion(null);
      submit(offer);
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <Modal
      onClose={close}
      title={t("packages.shareTitle")}
      actions={
        <Button variant="outline" type="button" onClick={close}>
          {t("btn.close", { ns: "common" })}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="share-target" className="mb-0">
          {t("packages.shareUseLabel")}
        </Label>
        <div className="flex gap-2">
          <Select value={target || undefined} onValueChange={setTarget}>
            <SelectTrigger id="share-target" className="w-full">
              <SelectValue placeholder={t("packages.shareUsePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {members.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("packages.shareGroupPeople")}</SelectLabel>
                  {members.map((member) => (
                    <SelectItem
                      key={member.userId}
                      value={targetValue({ kind: "user", userId: member.userId })}
                    >
                      {memberLabel(member)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {destinations.length > 0 && (
                <SelectGroup>
                  <SelectLabel>{t("orgSettings.inviteSpacesLabel")}</SelectLabel>
                  {destinations.map((candidate) => (
                    <SelectItem
                      key={candidate.id}
                      value={targetValue({ kind: "space", spaceId: candidate.id })}
                    >
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <PendingButton
            type="button"
            pending={share.isPending}
            disabled={!selected}
            onClick={() => selected && submit(selected)}
          >
            {t("packages.shareSubmit")}
          </PendingButton>
        </div>
        <p className="text-muted-foreground text-sm">
          {selected?.kind === "user"
            ? t("packages.shareUserHint")
            : selected?.kind === "space"
              ? t("packages.shareSpaceHint")
              : t("packages.shareUseHint")}
        </p>
        {/* Said BEFORE the offer: integrations are judged where the run starts, so a recipient without them gets an unexplained `integration_not_active`. */}
        {declaredIntegrations.length > 0 && (
          <p className="text-muted-foreground text-sm">
            {t("packages.shareIntegrationsHint", {
              count: declaredIntegrations.length,
              list: declaredIntegrations.join(", "),
            })}
          </p>
        )}

        {needsVersion && (
          <Alert
            variant="warning"
            data-testid="share-needs-version"
            className="bg-warning/10 mt-2 rounded-md p-3"
          >
            <AlertDescription className="flex flex-col items-start gap-2">
              <p>{t("packages.shareNeedsVersion")}</p>
              {canPublish ? (
                <PendingButton
                  type="button"
                  size="sm"
                  pending={publish.isPending}
                  disabled={share.isPending}
                  onClick={() => void publishAndShare()}
                >
                  {t("packages.sharePublishAndShare")}
                </PendingButton>
              ) : (
                <p className="text-muted-foreground">{t("packages.shareNeedsVersionNoWrite")}</p>
              )}
            </AlertDescription>
          </Alert>
        )}

        <ShareList
          shares={shares}
          isLoading={isLoading}
          revoking={revoke.isPending}
          onRevoke={(entry) =>
            revoke.mutate(
              {
                params: {
                  path: { ...splitPackageRef(packageId), target: shareTargetHandle(entry) },
                },
              },
              { onSuccess: () => toast.success(t("packages.shareRevoked")) },
            )
          }
        />

        {home && (
          <HomeSpaceNote
            personal={home.personal}
            onMoveHome={onMoveHome}
            onManageMembers={manageMembers}
          />
        )}
      </div>
    </Modal>
  );
}

/** The audience, each target with the state the package has THERE. */
export function ShareList({
  shares,
  isLoading,
  revoking,
  onRevoke,
}: {
  shares: PackageShare[] | undefined;
  isLoading: boolean;
  revoking: boolean;
  onRevoke: (entry: PackageShare) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mt-2 flex flex-col gap-1 border-t pt-4">
      <p className="text-sm font-medium">{t("packages.shareCurrent")}</p>
      {isLoading ? (
        <TextSkeleton lines={2} className="py-1.5" />
      ) : (shares ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("packages.shareEmpty")}</p>
      ) : (
        <ul className="divide-y">
          {(shares ?? []).map((entry) => (
            <li
              key={`${entry.target.kind}:${shareTargetHandle(entry)}`}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate">
                  {entry.target.kind === "user"
                    ? t("packages.shareWithPerson", { name: entry.target.name })
                    : t("packages.shareWithSpace", { name: entry.target.name })}
                </span>
                <Badge variant={entry.enabled ? "success" : "pending"}>
                  {entry.enabled
                    ? t("packages.shareStateActive")
                    : t("packages.shareStateInactive")}
                </Badge>
              </span>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                title={t("packages.shareRevokeHint")}
                disabled={revoking}
                onClick={() => onRevoke(entry)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where co-editing happens: membership of the HOME space. A personal home takes no other member
 * (`personal_space_has_no_members`), so the gesture there is to move the PACKAGE (`PUT …/home`).
 */
export function HomeSpaceNote({
  personal,
  onMoveHome,
  onManageMembers,
}: {
  personal: boolean;
  onMoveHome?: () => void;
  /** Stands in the home space; absent when the caller cannot enter it. */
  onManageMembers?: () => void;
}) {
  const { t } = useTranslation("settings");
  if (personal) {
    return (
      <div
        className="mt-2 flex flex-col items-start gap-2 border-t pt-4"
        data-testid="home-personal"
      >
        <p className="text-muted-foreground text-sm">{t("packages.homePersonal")}</p>
        {onMoveHome && (
          <Button type="button" size="sm" variant="outline" onClick={onMoveHome}>
            {t("packages.homePersonalMove")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col items-start gap-2 border-t pt-4" data-testid="home-team">
      <p className="text-muted-foreground text-sm">{t("packages.homeTeam")}</p>
      {onManageMembers && (
        <Link
          to="/workspace-settings/members"
          onClick={onManageMembers}
          className="text-sm underline"
        >
          {t("packages.homeManageMembers")}
        </Link>
      )}
    </div>
  );
}
