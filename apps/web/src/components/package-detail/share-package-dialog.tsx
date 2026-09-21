// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { useSpaceGrant } from "../../hooks/use-permissions";
import { coeditVerdict } from "../../lib/package-permissions";
import { useAddSpaceMember, useSpaceMembers } from "../../hooks/use-space-members";
import {
  DEFAULT_SPACE_ROLE_VALUE,
  spaceRoleAssignment,
  useSpaceRoleOptions,
} from "../../hooks/use-roles";
import { useCreateVersion } from "../../hooks/use-packages";
import {
  shareTargetHandle,
  usePackageShares,
  useRevokePackageShare,
  useSharePackage,
} from "../../hooks/use-package-shares";

/** The subject of one offer, as the picker encodes it. */
type ShareTarget = { kind: "user"; user_id: string } | { kind: "space"; space_id: string };

/**
 * One `<SelectItem>` value carrying both halves of a target. A space id is
 * `spc_…` and a user id is not, so the prefix is redundant for parsing — it is
 * there so a value can never be read as the other kind by accident.
 */
function targetValue(target: ShareTarget): string {
  return target.kind === "user" ? `user:${target.user_id}` : `space:${target.space_id}`;
}

function parseTargetValue(value: string): ShareTarget | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;
  if (kind === "user") return { kind: "user", user_id: id };
  if (kind === "space") return { kind: "space", space_id: id };
  return null;
}

/**
 * The two things "sharing" can mean, named separately (#1440).
 *
 * DISTRIBUTION ("Utiliser") is the offer of RBAC spec §6.10: the recipient gets
 * the package placed in their own space, switches it on themselves, and it runs
 * with THEIR credentials against its latest published version. Editing stays
 * home.
 *
 * COLLABORATION ("Co-éditer") is not that act at all — it is a role in the
 * package's HOME space, so the other person works on the live object where it
 * lives. Two tables, two targets, and one of them is refused outright when the
 * home is personal, which is why this is two tabs and not one dropdown of
 * escalating strengths: a spectrum would promise a middle that does not exist.
 *
 * Distribution takes ONE picker over people AND spaces, the shape Notion and
 * Copilot Studio both use, because "person or space" is a property of the
 * target, not a second intent — splitting it into tabs put two different axes
 * in one `TabsList`.
 */
export function SharePackageDialog({
  open,
  onClose,
  packageId,
  type,
  homeSpaceId,
  canPublish,
  onMoveHome,
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
  /**
   * Hand the reader over to the move-home dialog, the ONE way a package leaves
   * a personal space (`PUT …/home`; a personal space is never converted —
   * `personal_space_not_orphaned`). Owned by the caller rather than rendered
   * here so two modals never stack.
   */
  onMoveHome?: () => void;
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
  const [target, setTarget] = useState("");
  /** The offer the server refused for want of a version, kept to replay it. */
  const [needsVersion, setNeedsVersion] = useState<ShareTarget | null>(null);

  /** Already-offered subjects, so the picker does not propose a no-op. */
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

  const selected = parseTargetValue(target);

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
          // Not an error to report and walk away from: it is a missing step,
          // and the next panel performs it. Every other refusal is terminal
          // here and stays a toast.
          if (error instanceof ApiError && error.code === "package_has_no_version") {
            setNeedsVersion(offer);
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
    const offer = needsVersion;
    if (!offer) return;
    try {
      const created = await publish.mutateAsync(undefined);
      toast.success(t("packages.sharePublished", { version: created.version }));
      setNeedsVersion(null);
      submit(offer);
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
      <Tabs defaultValue="use">
        <TabsList>
          <TabsTrigger value="use">{t("packages.shareTabUse")}</TabsTrigger>
          <TabsTrigger value="coedit">{t("packages.shareTabCoedit")}</TabsTrigger>
        </TabsList>
        <TabsContent value="use" className="space-y-2">
          <Label htmlFor="share-target">{t("packages.shareUseLabel")}</Label>
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
                        value={targetValue({ kind: "user", user_id: member.userId })}
                      >
                        {member.displayName || member.email || member.userId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {destinations.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>{t("packages.shareGroupSpaces")}</SelectLabel>
                    {destinations.map((candidate) => (
                      <SelectItem
                        key={candidate.id}
                        value={targetValue({ kind: "space", space_id: candidate.id })}
                      >
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              disabled={!selected || share.isPending}
              onClick={() => selected && submit(selected)}
            >
              {share.isPending ? <Spinner /> : t("packages.shareSubmit")}
            </Button>
          </div>
          {/*
            One picker, two outcomes: what the recipient gets differs by KIND,
            so the hint follows the selection rather than stating a half-truth
            about whichever one the reader did not pick.
          */}
          <p className="text-muted-foreground text-sm">
            {selected?.kind === "user"
              ? t("packages.shareUserHint")
              : selected?.kind === "space"
                ? t("packages.shareSpaceHint")
                : t("packages.shareUseHint")}
          </p>

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
                              path: {
                                ...splitPackageRef(packageId),
                                target: shareTargetHandle(entry),
                              },
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
        </TabsContent>
        <TabsContent value="coedit">
          <CoeditTab
            open={open}
            homeSpaceId={homeSpaceId}
            orgMembers={org?.members ?? []}
            onMoveHome={onMoveHome}
          />
        </TabsContent>
      </Tabs>
    </Modal>
  );
}

/**
 * Co-authoring, which is a role in the package's HOME space and nothing else.
 *
 * Always rendered, never hidden behind the cases where it is possible: the
 * absence of this gesture IS the bug (#1440), so the tab that cannot perform it
 * has to say why instead of disappearing. Three answers, read off the home
 * space's own grant rather than `can` — `can` answers for the space the reader
 * is standing in, which is rarely this one.
 */
function CoeditTab({
  open,
  homeSpaceId,
  orgMembers,
  onMoveHome,
}: {
  open: boolean;
  homeSpaceId: string | null | undefined;
  orgMembers: Array<{ userId: string; displayName?: string | null; email?: string | null }>;
  onMoveHome?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const home = useSpaceGrant(homeSpaceId);
  const homeName = (useSpaces(open).data ?? []).find((space) => space.id === homeSpaceId)?.name;
  const verdict = coeditVerdict(home);
  const mayInvite = verdict === "invite";
  const mayRead = home?.permissions.includes("space-members:read") ?? false;
  // Only to spare the picker a candidate the server would refuse with `409
  // space_member_exists`: `space-members:read` is a separate grant from
  // `invite`, so when it is missing the list is simply not narrowed and the
  // refusal does the talking.
  const { data: existing } = useSpaceMembers(homeSpaceId ?? "", open && mayInvite && mayRead);
  const roles = useSpaceRoleOptions(homeSpaceId ?? undefined, open && mayInvite);
  const addMember = useAddSpaceMember();
  const [member, setMember] = useState("");
  const [role, setRole] = useState(DEFAULT_SPACE_ROLE_VALUE);

  // Everyone who already reaches the home space — the CALLER included, since
  // holding `<type>:share` there means holding a role there. So this is also
  // what keeps the reader from offering the space to themselves, and when
  // `space-members:read` is absent the `409` is what says it instead.
  const reached = useMemo(() => new Set((existing ?? []).map((row) => row.userId)), [existing]);
  const candidates = orgMembers.filter((candidate) => !reached.has(candidate.userId));

  if (verdict === "unknown") return <Spinner />;

  // A personal space belongs to ONE member and takes no others
  // (`personal_space_has_no_members`), and it is never converted while it lives
  // (`personal_space_not_orphaned`). So the gesture is to move the PACKAGE out,
  // which `PUT …/home` already allows in exactly this direction.
  if (verdict === "personal") {
    return (
      <div className="space-y-3" data-testid="coedit-personal">
        <p className="text-muted-foreground text-sm">{t("packages.coeditPersonal")}</p>
        {onMoveHome && (
          <Button type="button" size="sm" variant="outline" onClick={onMoveHome}>
            {t("packages.coeditPersonalMove")}
          </Button>
        )}
      </div>
    );
  }

  if (verdict === "no_authority") {
    return (
      <p className="text-muted-foreground text-sm" data-testid="coedit-no-authority">
        {t("packages.coeditNoAuthority", { space: homeName ?? "" })}
      </p>
    );
  }

  const submit = () => {
    if (!member || !homeSpaceId) return;
    addMember.mutate(
      {
        params: { path: { id: homeSpaceId } },
        body: { userId: member, ...spaceRoleAssignment(role) },
      },
      {
        onSuccess: () => {
          toast.success(t("packages.coeditDone", { space: homeName ?? "" }));
          setMember("");
        },
        onError: (error) => {
          // Said in the reader's language: the picker cannot narrow this one
          // away without `space-members:read`, and an owner/admin is refused
          // for a reason of its own the server states in English.
          if (error instanceof ApiError && error.code === "space_member_exists") {
            toast.error(t("packages.coeditMemberExists"));
            return;
          }
          toast.error(getErrorMessage(error));
        },
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="coedit-invite">
      <Label htmlFor="coedit-member">{t("packages.coeditLabel")}</Label>
      <div className="flex gap-2">
        <Select value={member || undefined} onValueChange={setMember}>
          <SelectTrigger id="coedit-member" className="w-full">
            <SelectValue placeholder={t("packages.coeditPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate.userId} value={candidate.userId}>
                {candidate.displayName || candidate.email || candidate.userId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger
            id="coedit-role"
            className="w-48"
            aria-label={t("packages.coeditRoleLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" disabled={!member || addMember.isPending} onClick={submit}>
          {addMember.isPending ? <Spinner /> : t("packages.coeditSubmit")}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        {candidates.length === 0
          ? t("packages.coeditEmpty", { space: homeName ?? "" })
          : t("packages.coeditHint", { space: homeName ?? "" })}
      </p>
    </div>
  );
}
