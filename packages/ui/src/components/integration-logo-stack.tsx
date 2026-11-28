// SPDX-License-Identifier: Apache-2.0

import { cn } from "../cn.ts";
import { IntegrationIcon } from "./integration-icon.tsx";
import { Skeleton } from "./skeleton.tsx";
import { STACK_TILE, TileStack } from "./tile-stack.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { useUiLabels } from "./ui-labels.ts";

/** Logos drawn before the rest is counted. */
const MAX_LOGOS = 4;

/** An integration as the stack names and draws it: its manifest `icon`, null when none. */
interface StackedIntegration {
  id: string;
  name: string;
  icon: string | null;
}

/**
 * The integrations an agent uses, as their logos stacked ({@link TileStack}) with their names in a
 * tooltip, one a line. The tile is a space tile's ({@link STACK_TILE}), filled by the logo on its
 * white ground (`IntegrationIcon`), clipped to the tile's corners. One named in `inactive` (a
 * required integration not active in the space, which refuses the launch) is dimmed and said so in
 * the tooltip. Nothing when the agent uses none. The one stack every surface draws an agent's
 * integrations with: cards, rows, the chat's panel and a run's line in the thread.
 */
export function IntegrationLogoStack({
  integrations,
  inactive,
}: {
  integrations: readonly StackedIntegration[];
  inactive?: readonly string[];
}) {
  const labels = useUiLabels();
  if (integrations.length === 0) return null;
  const isInactive = (id: string) => inactive?.includes(id) ?? false;
  const named = integrations.map((integration) => ({
    id: integration.id,
    text: isInactive(integration.id)
      ? labels.integrationInactive(integration.name)
      : integration.name,
  }));
  const label = labels.integrationsNamed(named.map((n) => n.text).join(", "));
  return (
    <Tooltip>
      {/* Raised over a card's or a row's stretched link, or it would swallow the hover. */}
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="img"
            aria-label={label}
            className="relative z-10 flex shrink-0"
          />
        }
      >
        <TileStack
          items={integrations}
          keyOf={(integration) => integration.id}
          render={(integration, className) => (
            <span
              data-testid="integration-logo"
              className={cn("flex shrink-0 overflow-hidden", STACK_TILE, className)}
            >
              <IntegrationIcon
                src={integration.icon}
                className={cn(
                  "size-4 rounded-none",
                  isInactive(integration.id) && "opacity-40 grayscale",
                )}
                padding="p-0"
                fallbackClassName="size-3"
              />
            </span>
          )}
          tileClass={STACK_TILE}
          max={MAX_LOGOS}
          testId="integration-logo-stack"
        />
      </TooltipTrigger>
      {/* One name a line: an agent may use more integrations than a line holds. */}
      <TooltipContent>
        <p className="font-medium">{labels.integrations}</p>
        <ul>
          {named.map((entry) => (
            <li key={entry.id}>{entry.text}</li>
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
