// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { AgentListIntegration } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { PackageIcon } from "./package-icon";
import { STACK_TILE, TileStack } from "./tile-stack";

/** Logos drawn before the rest is counted. */
const MAX_LOGOS = 4;

/**
 * The integrations an agent uses, as their logos stacked ({@link TileStack}) with their names in a
 * tooltip, one a line. The tile is a space tile's ({@link STACK_TILE}); the logo fills it edge to
 * edge, clipped to its corners, on the page background: most are transparent glyphs, which would
 * show through each other once they overlap. One named in `inactive` (a required integration not
 * active in the space, which refuses the launch) is dimmed and said so in the tooltip. Nothing
 * when the agent uses none.
 */
export function IntegrationLogoStack({
  integrations,
  inactive,
}: {
  integrations: readonly AgentListIntegration[];
  inactive?: readonly string[];
}) {
  const { t } = useTranslation("common");
  if (integrations.length === 0) return null;
  const isInactive = (id: string) => inactive?.includes(id) ?? false;
  const names = integrations.map((integration) =>
    isInactive(integration.id)
      ? t("integrationStack.inactive", { name: integration.name })
      : integration.name,
  );
  const label = t("integrationStack.label", { names: names.join(", ") });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Raised over a card's or a row's stretched link, or it would swallow the hover. */}
        <span tabIndex={0} role="img" aria-label={label} className="relative z-10 flex shrink-0">
          <TileStack
            items={integrations}
            keyOf={(integration) => integration.id}
            render={(integration, className) => (
              <span
                className={cn("bg-background flex shrink-0 overflow-hidden", STACK_TILE, className)}
              >
                <PackageIcon
                  type="integration"
                  icon={integration.icon}
                  size="xs"
                  className={cn(
                    "size-4 rounded-none",
                    isInactive(integration.id) && "opacity-40 grayscale",
                  )}
                />
              </span>
            )}
            tileClass={STACK_TILE}
            max={MAX_LOGOS}
            testId="integration-logo-stack"
          />
        </span>
      </TooltipTrigger>
      {/* One name a line: an agent may use more integrations than a line holds. */}
      <TooltipContent>
        <p className="font-medium">{t("integrationStack.title")}</p>
        <ul>
          {names.map((name, index) => (
            <li key={integrations[index]!.id}>{name}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** {@link IntegrationLogoStack} while its list loads: three tiles, overlapping as the logos do. */
export function IntegrationLogoStackSkeleton() {
  return (
    <TileStack
      items={["a", "b", "c"]}
      keyOf={(key) => key}
      render={(_, className) => <Skeleton className={cn(STACK_TILE, className)} />}
      tileClass={STACK_TILE}
    />
  );
}
