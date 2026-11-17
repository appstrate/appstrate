// SPDX-License-Identifier: Apache-2.0

/**
 * "What can this assistant do for me": the caller's role and a verdict per chat
 * act, as a section of the conversation's Info tab. Lives in the SHELL
 * (everything it reads is host state). A role preview (`X-View-As`) needs no
 * logic here: `/api/orgs` and `/api/spaces` already answer AS the persona; the
 * summary only marks it. The verdicts judge the spaces the conversation acts in, not the working
 * space the shell happens to stand in: every space the chat acts in, or the origin space alone for
 * a limited conversation, as the turn does. The role line names the working space while one is
 * selected; in « Tous les espaces » it names the organization role, and the conversation's origin
 * space by name (`accessStanding`).
 */

import { useTranslation } from "react-i18next";
import { BotOffIcon, CheckIcon, EyeIcon, ShieldIcon, XIcon } from "lucide-react";
import { usePackageAuthoringEnabled } from "@appstrate/module-chat/package-authoring";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { roleI18nKey, usePermissions } from "../../hooks/use-permissions";
import { spaceRoleLabel } from "../../hooks/use-roles";
import { useOrg } from "../../hooks/use-org";
import { useSpaces } from "../../hooks/use-spaces";
import type { SpaceGrant } from "../../lib/package-permissions";
import { actingSpaces, grantedInSomeActingSpace } from "../../lib/space-lists";
import { useViewAs } from "../../stores/view-as-store";
import {
  accessStanding,
  resolveChatCapabilities,
  type ResolvedChatCapability,
} from "./chat-access";

/** The conversation's scope, as its stored row states it. */
export interface ConversationScope {
  spaceId: string | null;
  restricted: boolean;
}

/**
 * `conversation`: `null` for none stored yet (it acts in every space the chat acts in),
 * `undefined` while it loads.
 */
export function ChatAccessSummary({
  conversation,
}: {
  conversation: ConversationScope | null | undefined;
}) {
  const { t } = useTranslation(["chat", "settings"]);
  const { ready, orgRole } = usePermissions();
  const orgPermissions = useOrg().currentOrg?.permissions;
  const spaceId = useCurrentSpaceId();
  const { on: overview } = useOverviewMode();
  const { data: spaces } = useSpaces();
  const persona = useViewAs();
  const authoring = usePackageAuthoringEnabled();

  // A verdict on a set still in flight reads as a denial: hold the box.
  if (!ready || orgRole === null || conversation === undefined) {
    return <Skeleton className="h-24 w-full rounded-md" />;
  }

  const roleIn = (id: string | null | undefined) =>
    spaceRoleLabel(spaces?.find((s) => s.id === id)?.role, (key) => t(key));
  const originSpace = spaces?.find((s) => s.id === conversation?.spaceId);
  const standing = accessStanding({
    overview,
    orgRole: t(`settings:${roleI18nKey(orgRole)}`),
    workingRole: roleIn(spaceId),
    origin: originSpace ? { name: originSpace.name, role: roleIn(originSpace.id) } : null,
  });
  const acting = actingSpaces(spaces, orgPermissions);
  const capabilities = resolveChatCapabilities({
    ...(conversation?.restricted
      ? limitedGrants(acting, conversation.spaceId)
      : {
          can: (permission) => grantedInSomeActingSpace(spaces, orgPermissions, permission),
          spaceGrants: acting,
        }),
    authoring,
  });
  const RoleIcon = persona ? EyeIcon : ShieldIcon;

  return (
    <section className={cn("flex flex-col gap-2", persona && "text-foreground")}>
      <h3 className="text-sm font-medium">{t("chat:context.info.access")}</h3>
      <p className="text-muted-foreground text-xs">{t("chat:access.subtitle")}</p>
      <div className="flex items-center gap-2 text-sm">
        <RoleIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{standing.headline}</span>
      </div>
      <ChatCapabilityList capabilities={capabilities} />
      <p className="text-muted-foreground border-t pt-2 text-xs">
        {t(`chat:${standing.line.key}`, standing.line.params)}
      </p>
      {persona ? (
        <p className="text-muted-foreground text-xs">{t("chat:access.previewing")}</p>
      ) : null}
    </section>
  );
}

/**
 * A limited conversation acts in its origin space alone, and in none once the caller cannot act
 * there. Of the org-level half the turn keeps only a few reads (`limitedConversationPermissions`,
 * module-chat), none of which a row reads: the origin space's own grants decide every row.
 */
function limitedGrants(acting: readonly (SpaceGrant & { id: string })[], originId: string | null) {
  const origin = acting.find((space) => space.id === originId);
  return {
    can: (permission: string) => !!origin?.permissions.includes(permission),
    spaceGrants: origin ? [origin] : [],
  };
}

/** One item per capability with the verdict INSIDE it; the icon is `aria-hidden`, the spoken verdict follows the label. */
export function ChatCapabilityList({
  capabilities,
}: {
  capabilities: readonly ResolvedChatCapability[];
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <ul className="flex flex-col gap-1">
      {capabilities.map((capability) => {
        const off = capability.verdict === "off";
        const granted = capability.verdict === "granted";
        return (
          <li key={capability.id} className="flex items-center gap-2 text-xs">
            {off ? (
              <BotOffIcon aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
            ) : granted ? (
              <CheckIcon aria-hidden="true" className="text-success size-3.5 shrink-0" />
            ) : (
              <XIcon aria-hidden="true" className="text-muted-foreground/60 size-3.5 shrink-0" />
            )}
            <span
              className={cn(
                off
                  ? "text-muted-foreground"
                  : granted
                    ? "text-foreground"
                    : "text-muted-foreground line-through",
              )}
            >
              {t(`chat:${capability.labelKey}`)}
              {off && ` (${t("chat:access.turnedOff")})`}
            </span>
            {!off && (
              <span className="sr-only">
                {", "}
                {t(granted ? "chat:access.granted" : "chat:access.denied")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
