// SPDX-License-Identifier: Apache-2.0

/**
 * "What can this assistant do for me" — the caller's role, and the handful of
 * acts the chat performs, each with a verdict.
 *
 * Lives in the SHELL, not in `module-chat`, and reaches the chat through the
 * `headerActions` prop the page already has — the same seam
 * `ConversationContextActions` uses. Everything it reads (the effective
 * permission set, the persona, the view-as dialog) is host state, and routing
 * it through a new `ChatHost` member would have bought nothing but a wider
 * injection surface.
 *
 * NOT in the composer's model popover, deliberately. Picking a model is an
 * ACT; a role is a STATE one is subject to. Putting them behind one control
 * suggests the second can be changed there like the first.
 *
 * The preview persona needs no handling of its own: `/api/orgs` and
 * `/api/spaces` both carry `X-View-As` through the client middleware, so
 * `usePermissions()` and the space row already answer AS the persona. An
 * owner previewing `runner` sees the runner's verdicts here, which is the
 * whole point of a preview.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, EyeIcon, ShieldIcon, XIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { ViewAsDialog } from "../../components/view-as-dialog";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import {
  roleI18nKey,
  useCanPreviewRole,
  useCurrentSpaceGrant,
  usePermissions,
} from "../../hooks/use-permissions";
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
  const canPreview = useCanPreviewRole();
  const [previewing, setPreviewing] = useState(false);

  // Nothing truthful to say until both lists have landed: `can` answers
  // `false` for a set still in flight, which renders exactly like a denial.
  // A chip that flashes "you may do nothing" on every hard reload would be
  // worse than one that appears a beat late.
  if (!ready || orgRole === null) return null;

  const spaceRole = spaceRoleLabel(spaces?.find((s) => s.id === spaceId)?.role, (key) => t(key));
  const orgRoleLabel = t(`settings:${roleI18nKey(orgRole)}`);
  const roleLabel = spaceRole ?? orgRoleLabel;
  const capabilities = resolveChatCapabilities({ can, spaceGrant });

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 gap-1.5 px-2.5 text-xs",
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
          side="bottom"
          align="end"
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

          {/* The preview is STARTED from one place only (`ViewAsDialog`) and
              ENDED from the app-wide banner, which is already on screen while
              one is active. So this offers the entry point and never a second
              exit — two exits would be two things to keep in step. */}
          {persona ? (
            <p className="text-muted-foreground mt-1 text-xs">{t("chat:access.previewing")}</p>
          ) : canPreview ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 w-full justify-start px-1.5 text-xs"
              onClick={() => setPreviewing(true)}
            >
              <EyeIcon className="size-3.5" />
              {t("chat:access.preview")}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
      {previewing && <ViewAsDialog onClose={() => setPreviewing(false)} />}
    </>
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
      {capabilities.map((capability) => (
        <li key={capability.id} className="flex items-center gap-2 text-xs">
          {capability.granted ? (
            <CheckIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
          ) : (
            <XIcon aria-hidden="true" className="text-muted-foreground/60 size-3.5 shrink-0" />
          )}
          <span
            className={cn(
              capability.granted ? "text-foreground" : "text-muted-foreground line-through",
            )}
          >
            {t(`chat:${capability.labelKey}`)}
          </span>
          <span className="sr-only">
            {" — "}
            {t(capability.granted ? "chat:access.granted" : "chat:access.denied")}
          </span>
        </li>
      ))}
    </ul>
  );
}
