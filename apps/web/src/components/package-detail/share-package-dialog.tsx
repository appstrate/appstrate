// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@appstrate/ui/components/tabs";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import type { PackageType } from "@appstrate/core/validation";
import { $api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { splitPackageRef } from "../../lib/package-paths";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useSpaces } from "../../hooks/use-spaces";
import { useCreateVersion } from "../../hooks/use-packages";
import {
  shareTargetHandle,
  usePackageShares,
  useRevokePackageShare,
  useSharePackage,
} from "../../hooks/use-package-shares";

/** The subject of one offer, as the two tabs spell it. */
type ShareTarget = { kind: "user"; user_id: string } | { kind: "space"; space_id: string };

/**
 * A package's AUDIENCE — who it is offered to (RBAC spec §6.10).
 *
 * Two tabs because there are two kinds of subject and a person is not a space:
 * picking someone shares with THEIR personal space, resolved server-side, so
 * this dialog never handles that id. The list below is the current audience,
 * and revoking from it takes the placement away with the share — the package
 * stops being readable AND stops running there, which is why the button says
 * so.
 *
 * Offering needs a published version, whatever the target (`409
 * package_has_no_version`): away from its home a package runs the latest
 * published version and nothing else, so an offer of a package with nothing
 * published is an offer of nothing. Rather than report that as an error the
 * author must go elsewhere to fix, the dialog answers it in place: publish the
 * draft's own version, then complete the offer that was refused.
 */
export function SharePackageDialog({
  open,
  onClose,
  packageId,
  type,
  homeSpaceId,
  canPublish,
}: {
  open: boolean;
  onClose: () => void;
  packageId: string;
  /** Publishing is per-type — the version routes are `/api/packages/<type>/…`. */
  type: PackageType;
  /** The package's home — never a share destination; it already lives there. */
  homeSpaceId: string | null | undefined;
  /**
   * `home_writable`: publishing is a WRITE in the home space, and a custom role
   * may grant `share` without it (RBAC spec §6.10). Without it the dialog states
   * the refusal and names no button the server would turn down.
   */
  canPublish: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const orgId = useCurrentOrgId();
  const { data: shares, isLoading } = usePackageShares(packageId, open);
  const { data: spaces } = useSpaces(open);
  const { data: org } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: open && !!orgId },
  );
  const share = useSharePackage();
  const revoke = useRevokePackageShare();
  const publish = useCreateVersion(type, packageId);
  const [user, setUser] = useState("");
  const [space, setSpace] = useState("");
  /** The offer the server refused for want of a version, kept to replay it. */
  const [needsVersion, setNeedsVersion] = useState<ShareTarget | null>(null);

  /** Already-offered subjects, so the pickers do not propose a no-op. */
  const offered = useMemo(() => new Set((shares ?? []).map(shareTargetHandle)), [shares]);

  /**
   * The home's OWNER is a no-op target as surely as the home space itself — a
   * person resolves server-side to their personal space — but this projection
   * cannot identify them: a personal space's owner is deliberately not named on
   * the wire. So the picker may still offer one, and the `409
   * share_target_is_home` branch below is what says so, in the reader's own
   * language.
   */
  const members = (org?.members ?? []).filter((member) => !offered.has(member.userId));
  // A share destination is a space the caller reaches that is neither the
  // package's home nor their OWN personal space: the first already has it, and
  // the second is reached by activating it, not by offering it to yourself.
  const destinations = (spaces ?? []).filter(
    (candidate) =>
      !candidate.personal &&
      candidate.id !== homeSpaceId &&
      candidate.access === "member" &&
      !offered.has(candidate.id),
  );

  const close = () => {
    setUser("");
    setSpace("");
    setNeedsVersion(null);
    onClose();
  };

  const submit = (target: ShareTarget) =>
    share.mutate(
      { params: { path: splitPackageRef(packageId) }, body: { target } },
      {
        onSuccess: () => {
          toast.success(t("packages.shareDone"));
          setUser("");
          setSpace("");
          setNeedsVersion(null);
        },
        onError: (error) => {
          // Not an error to report and walk away from: it is a missing step,
          // and the next panel performs it. Every other refusal is terminal
          // here and stays a toast.
          if (error instanceof ApiError && error.code === "package_has_no_version") {
            setNeedsVersion(target);
            return;
          }
          // Terminal like the rest, but said in the reader's language: the
          // server's `detail` is English, and the picker cannot always rule
          // this target out beforehand (it never learns whose personal space
          // another member's is).
          if (error instanceof ApiError && error.code === "share_target_is_home") {
            toast.error(t("packages.shareTargetIsHome"));
            return;
          }
          toast.error(getErrorMessage(error));
        },
      },
    );

  /**
   * Publish the draft under the version its own manifest declares, then replay
   * the refused offer. Two calls the author could make by hand, in the order
   * that makes the second one succeed — the server publishes nothing on its own
   * (freezing somebody's working copy is their decision, not a side effect of
   * a share).
   */
  const publishAndShare = async () => {
    const target = needsVersion;
    if (!target) return;
    try {
      const created = await publish.mutateAsync(undefined);
      toast.success(t("packages.sharePublished", { version: created.version }));
      setNeedsVersion(null);
      submit(target);
    } catch (error) {
      // An incomplete draft is refused at publish (empty callable selections,
      // a manifest the freeze point rejects): the server's own words say which.
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("packages.shareTitle")}
      actions={
        <Button variant="outline" type="button" onClick={close}>
          {t("btn.close", { ns: "common" })}
        </Button>
      }
    >
      <Tabs defaultValue="person">
        <TabsList>
          <TabsTrigger value="person">{t("packages.shareTabPerson")}</TabsTrigger>
          <TabsTrigger value="space">{t("packages.shareTabSpace")}</TabsTrigger>
        </TabsList>
        <TabsContent value="person" className="space-y-2">
          <Label htmlFor="share-user">{t("packages.shareUserLabel")}</Label>
          <div className="flex gap-2">
            <Select value={user || undefined} onValueChange={setUser}>
              <SelectTrigger id="share-user" className="w-full">
                <SelectValue placeholder={t("packages.shareUserPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {members.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.displayName || member.email || member.userId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              disabled={!user || share.isPending}
              onClick={() => submit({ kind: "user", user_id: user })}
            >
              {share.isPending ? <Spinner /> : t("packages.shareSubmit")}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">{t("packages.shareUserHint")}</p>
        </TabsContent>
        <TabsContent value="space" className="space-y-2">
          <Label htmlFor="share-space">{t("packages.shareSpaceLabel")}</Label>
          <div className="flex gap-2">
            <Select value={space || undefined} onValueChange={setSpace}>
              <SelectTrigger id="share-space" className="w-full">
                <SelectValue placeholder={t("packages.shareSpacePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              disabled={!space || share.isPending}
              onClick={() => submit({ kind: "space", space_id: space })}
            >
              {share.isPending ? <Spinner /> : t("packages.shareSubmit")}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">{t("packages.shareSpaceHint")}</p>
        </TabsContent>
      </Tabs>

      {needsVersion && (
        <div
          data-testid="share-needs-version"
          className="mt-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <p>{t("packages.shareNeedsVersion")}</p>
          {canPublish ? (
            <Button
              type="button"
              size="sm"
              disabled={publish.isPending || share.isPending}
              onClick={() => void publishAndShare()}
            >
              {publish.isPending ? <Spinner /> : t("packages.sharePublishAndShare")}
            </Button>
          ) : (
            <p className="text-muted-foreground">{t("packages.shareNeedsVersionNoWrite")}</p>
          )}
        </div>
      )}

      <div className="mt-4 space-y-1 border-t pt-4">
        <p className="text-sm font-medium">{t("packages.shareCurrent")}</p>
        {isLoading ? (
          <Spinner />
        ) : (shares ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("packages.shareEmpty")}</p>
        ) : (
          <ul className="divide-y">
            {(shares ?? []).map((entry) => (
              <li
                key={`${entry.target.kind}:${shareTargetHandle(entry)}`}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <span className="truncate text-sm">
                  {entry.target.kind === "user"
                    ? t("packages.shareWithPerson", { name: entry.target.name })
                    : t("packages.shareWithSpace", { name: entry.target.name })}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  title={t("packages.shareRevokeHint")}
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(
                      {
                        params: {
                          path: { ...splitPackageRef(packageId), target: shareTargetHandle(entry) },
                        },
                      },
                      {
                        onSuccess: () => toast.success(t("packages.shareRevoked")),
                        onError: (error) => toast.error(getErrorMessage(error)),
                      },
                    )
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
