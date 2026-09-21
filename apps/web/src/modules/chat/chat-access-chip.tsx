// SPDX-License-Identifier: Apache-2.0

/**
 * "What can this assistant do for me" — the caller's role, and the handful of
 * acts the chat performs, each with a verdict.
 *
 * Lives in the SHELL, not in `module-chat`, and reaches the composer through
 * the `composerActions` prop, beside the model picker: it answers a question
 * about the message being written. Everything it reads (the effective
 * permission set, the persona) is host state, so routing it through a
 * `ChatHost` member would buy nothing but a wider injection surface.
 *
 * An active role preview (`X-View-As`) needs no permission logic here:
 * `/api/orgs` and `/api/spaces` already answer AS the persona, so an owner
 * previewing `runner` sees the runner's verdicts. The chip only marks it (eye
 * icon, closing line).
 */

import { useTranslation } from "react-i18next";
import { BotOffIcon, CheckIcon, EyeIcon, ShieldIcon, XIcon } from "lucide-react";
import { useAgentAuthoringEnabled } from "@appstrate/module-chat/agent-authoring";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { roleI18nKey, useCurrentSpaceGrant, usePermissions } from "../../hooks/use-permissions";
import { spaceRoleLabel } from "../../hooks/use-roles";
import { useSpaces } from "../../hooks/use-spaces";
import { useViewAs } from "../../stores/view-as-store";
import { resolveChatCapabilities, type ResolvedChatCapability } from "./chat-access";

export function ChatAccessChip() {
  const { t } = useTranslation(["chat", "settings"]);
  const { can, ready, orgRole } = usePermissions();
  const spaceGrant = useCurrentSpaceGrant();
  const spaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const persona = useViewAs();
  const authoring = useAgentAuthoringEnabled();

  // Nothing truthful to say until both lists have landed: `can` answers
  // `false` for a set still in flight, which renders exactly like a denial.
  // A chip that flashes "you may do nothing" on every hard reload would be
  // worse than one that appears a beat late.
  if (!ready || orgRole === null) return null;

  const spaceRole = spaceRoleLabel(spaces?.find((s) => s.id === spaceId)?.role, (key) => t(key));
  const orgRoleLabel = t(`settings:${roleI18nKey(orgRole)}`);
  const roleLabel = spaceRole ?? orgRoleLabel;
  const capabilities = resolveChatCapabilities({ can, spaceGrant, authoring });

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Same shape as the model picker it sits beside. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "text-foreground hover:text-foreground h-auto gap-1.5 px-2.5 py-1 font-normal shadow-none [&_svg]:size-3.5",
            "min-w-0",
            persona && "border-primary/40 bg-primary/5",
          )}
          // The accessible name CONTAINS the visible text (WCAG 2.5.3): a
          // voice user saying the role they see on the button reaches it.
          aria-label={t("chat:access.triggerLabel", { role: roleLabel })}
        >
          {persona ? (
            <EyeIcon className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ShieldIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="max-w-40 truncate font-medium">{roleLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-3"
      >
        <p className="text-sm font-medium">{t("chat:access.title")}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{t("chat:access.subtitle")}</p>

        <ChatCapabilityList capabilities={capabilities} />

        <p className="text-muted-foreground mt-3 border-t pt-2 text-xs">
          {t("chat:access.roleLine", { org: orgRoleLabel, space: spaceRole ?? "—" })}
        </p>
        {persona ? (
          <p className="text-muted-foreground mt-1 text-xs">{t("chat:access.previewing")}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One list item per capability, the verdict INSIDE the item it judges. The
 * check/cross is decoration (`aria-hidden`); what a screen reader announces is
 * the label followed by its spoken verdict, in DOM order, so the two can never
 * be read against a neighbouring row.
 */
export function ChatCapabilityList({
  capabilities,
}: {
  capabilities: readonly ResolvedChatCapability[];
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <ul className="mt-2 space-y-1">
      {capabilities.map((capability) => {
        const off = capability.verdict === "off";
        const granted = capability.verdict === "granted";
        return (
          <li key={capability.id} className="flex items-center gap-2 text-xs">
            {off ? (
              <BotOffIcon aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
            ) : granted ? (
              <CheckIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
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
              {off && ` — ${t("chat:access.turnedOff")}`}
            </span>
            {!off && (
              <span className="sr-only">
                {" — "}
                {t(granted ? "chat:access.granted" : "chat:access.denied")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
