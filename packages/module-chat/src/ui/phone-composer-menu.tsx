// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's tools below `md`: ONE "+" at the left of the field that opens the tools panel
 * (`ComposerToolsPanel`) from the bottom, as the chats people already use do. Nothing of them stays
 * beside the field: a dot on the "+" says a setting is off its default (`useComposerDepartures`),
 * and the panel names it. From `md` up the same panel opens in a popover (`ComposerTools`).
 */

import { PlusIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import {
  useComposerDepartures,
  useComposerPanel,
  useComposerPanelHeading,
} from "./composer-panel.ts";
import { ComposerToolsPanel } from "./composer-tools-panel.tsx";
import { useChatHost } from "./runtime-context.ts";
import { SheetMenu } from "./sheet-menu.tsx";
import { COMPOSER_TOOL_BUTTON_CLASS } from "./touch-targets.ts";

/** The dot on the panel's opener while a setting departs from its default. */
export function DepartureDot({ testId }: { testId: string }) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      className="bg-primary ring-card desktop-pointer:top-1 desktop-pointer:right-1 absolute top-1.5 right-1.5 size-2 rounded-full ring-2"
    />
  );
}

export function ComposerPlusMenu({ authorsPackages }: { authorsPackages: boolean }) {
  const { t } = useChatHost();
  const panel = useComposerPanel();
  const heading = useComposerPanelHeading();
  const departed = useComposerDepartures(authorsPackages).length > 0;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(COMPOSER_TOOL_BUTTON_CLASS, "relative md:hidden")}
        aria-label={t("composer.tools")}
        aria-haspopup="dialog"
        data-testid="composer-plus"
        onClick={() => panel.openAt("tools")}
      >
        <PlusIcon />
        {departed && <DepartureDot testId="composer-plus-dot" />}
      </Button>
      <SheetMenu
        open={panel.open === "sheet"}
        onOpenChange={(open) => !open && panel.close()}
        title={heading.title}
        back={heading.back}
      >
        <ComposerToolsPanel authorsPackages={authorsPackages} phone />
      </SheetMenu>
    </>
  );
}
