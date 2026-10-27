// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { Card } from "@appstrate/ui/components/card";
import { cn } from "@appstrate/ui/cn";

/**
 * Rows stacked in one card, a hairline between them (the dashboard's recent runs and upcoming
 * schedules). `overflow-hidden` clips a row's hover wash to the card's corners, so a row carries
 * no radius of its own. Flat like every other card: no shadow.
 */
export function CardList({ className, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn("divide-border divide-y overflow-hidden rounded-xl", className)}
      {...props}
    />
  );
}
