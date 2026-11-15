// SPDX-License-Identifier: Apache-2.0

/**
 * "What can this assistant do for me": the caller's role and a verdict per chat
 * act, as a section of the conversation's Info tab. Lives in the SHELL
 * (everything it reads is host state). A role preview (`X-View-As`) needs no
 * logic here: `/api/orgs` and `/api/spaces` already answer AS the persona; the
 * summary only marks it.
 */

import { useTranslation } from "react-i18next";
import { BotOffIcon, CheckIcon, EyeIcon, ShieldIcon, XIcon } from "lucide-react";
import { usePackageAuthoringEnabled } from "@appstrate/module-chat/package-authoring";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { roleI18nKey, useCurrentSpaceGrant, usePermissions } from "../../hooks/use-permissions";
import { spaceRoleLabel } from "../../hooks/use-roles";
import { useSpaces } from "../../hooks/use-spaces";
import { useViewAs } from "../../stores/view-as-store";
import { resolveChatCapabilities, type ResolvedChatCapability } from "./chat-access";

export function ChatAccessSummary() {
  const { t } = useTranslation(["chat", "settings"]);
  const { can, ready, orgRole } = usePermissions();
  const spaceGrant = useCurrentSpaceGrant();
  const spaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const persona = useViewAs();
  const authoring = usePackageAuthoringEnabled();

  // `can` answers `false` while a set is in flight, which looks like a denial: hold the box.
  if (!ready || orgRole === null) return <Skeleton className="h-24 w-full rounded-md" />;

  const spaceRole = spaceRoleLabel(spaces?.find((s) => s.id === spaceId)?.role, (key) => t(key));
  const orgRoleLabel = t(`settings:${roleI18nKey(orgRole)}`);
  const roleLabel = spaceRole ?? orgRoleLabel;
  const capabilities = resolveChatCapabilities({ can, spaceGrant, authoring });
  const RoleIcon = persona ? EyeIcon : ShieldIcon;

  return (
    <section className={cn("flex flex-col gap-2", persona && "text-foreground")}>
      <h3 className="text-sm font-medium">{t("chat:context.info.access")}</h3>
      <p className="text-muted-foreground text-xs">{t("chat:access.subtitle")}</p>
      <div className="flex items-center gap-2 text-sm">
        <RoleIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{roleLabel}</span>
      </div>
      <ChatCapabilityList capabilities={capabilities} />
      <p className="text-muted-foreground border-t pt-2 text-xs">
        {t("chat:access.roleLine", { org: orgRoleLabel, space: spaceRole ?? "—" })}
      </p>
      {persona ? (
        <p className="text-muted-foreground text-xs">{t("chat:access.previewing")}</p>
      ) : null}
    </section>
  );
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
