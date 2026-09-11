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
import { $api } from "../../api/client";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { splitPackageRef } from "../../lib/package-paths";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useSpaces } from "../../hooks/use-spaces";
import {
  shareTargetHandle,
  usePackageShares,
  useRevokePackageShare,
  useSharePackage,
} from "../../hooks/use-package-shares";

/**
 * A package's AUDIENCE — who it is offered to (RBAC spec §6.10).
 *
 * Two tabs because there are two kinds of subject and a person is not a space:
 * picking someone shares with THEIR personal space, resolved server-side, so
 * this dialog never handles that id. The list below is the current audience,
 * and revoking from it also uninstalls the package for that recipient — which
 * is why the button says so.
 */
export function SharePackageDialog({
  open,
  onClose,
  packageId,
  homeSpaceId,
}: {
  open: boolean;
  onClose: () => void;
  packageId: string;
  /** The package's home — never a share destination; it already lives there. */
  homeSpaceId: string | null | undefined;
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
  const [user, setUser] = useState("");
  const [space, setSpace] = useState("");

  /** Already-offered subjects, so the pickers do not propose a no-op. */
  const offered = useMemo(() => new Set((shares ?? []).map(shareTargetHandle)), [shares]);

  const members = (org?.members ?? []).filter((member) => !offered.has(member.userId));
  // A share destination is a space the caller reaches that is neither the
  // package's home nor their OWN personal space: the first already has it, and
  // the second is reached by installing, not by offering it to yourself.
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
    onClose();
  };

  const submit = (
    target: { kind: "user"; user_id: string } | { kind: "space"; space_id: string },
  ) =>
    share.mutate(
      { params: { path: splitPackageRef(packageId) }, body: { target } },
      {
        onSuccess: () => {
          toast.success(t("packages.shareDone"));
          setUser("");
          setSpace("");
        },
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    );

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
