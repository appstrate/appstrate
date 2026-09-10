// SPDX-License-Identifier: Apache-2.0
import { useId, type ReactNode } from "react";
import { Activity, CircleX, TriangleAlert } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Badge } from "@appstrate/ui/components/badge";
import { Link, type To } from "react-router-dom";

export function HealthIssueBadge({
  children,
  blocking = false,
  className,
}: {
  children: ReactNode;
  blocking?: boolean;
  className?: string;
}) {
  const Icon = blocking ? CircleX : TriangleAlert;
  return (
    <Badge variant={blocking ? "failed" : "warning"} className={cn("gap-1", className)}>
      <Icon className="size-3" aria-hidden />
      {children}
    </Badge>
  );
}

export function HealthAction({
  children,
  to,
  onClick,
  secondary = false,
}: {
  children: ReactNode;
  to?: To;
  onClick?: () => void;
  secondary?: boolean;
}) {
  const className = cn(
    "cursor-pointer rounded-none bg-transparent p-0 text-xs font-normal hover:bg-transparent hover:underline",
    secondary ? "text-muted-foreground hover:text-foreground" : "text-primary hover:text-primary",
  );
  return to ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}

/** Shared diagnostic layout. Domain components own findings and correction actions. */
export function HealthCard({
  title,
  badge,
  tone,
  cardHeaders = true,
  children,
}: {
  title: string;
  badge: ReactNode;
  tone: string;
  cardHeaders?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const Icon = tone === "blocking" ? CircleX : tone === "warning" ? TriangleAlert : Activity;
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "border-border rounded-lg border",
        cardHeaders ? "bg-muted/35 overflow-hidden" : "bg-card p-4",
        tone === "blocking" && "border-destructive/30",
        tone === "warning" && "border-warning/30",
      )}
    >
      <div
        className={cn("flex flex-wrap items-center gap-2", cardHeaders && "bg-muted/35 px-4 py-3")}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            tone === "blocking"
              ? "text-destructive"
              : tone === "warning"
                ? "text-warning"
                : "text-muted-foreground",
          )}
          aria-hidden
        />
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {badge}
      </div>
      <div className={cn(cardHeaders && "bg-card overflow-hidden rounded-t-lg border-t")}>
        {children}
      </div>
    </section>
  );
}

export function HealthCardItem({
  title,
  description,
  actions,
  cardHeaders = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
  cardHeaders?: boolean;
}) {
  return (
    <li
      className={cn(
        "grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]",
        cardHeaders ? "first:pt-4 last:pb-4" : "first:pt-0 last:pb-0",
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
      </div>
      <div className="flex items-center gap-3 text-xs sm:self-center">{actions}</div>
    </li>
  );
}
