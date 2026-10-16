// SPDX-License-Identifier: Apache-2.0
import { Badge } from "@appstrate/ui/components/badge";
import { useId, type ReactNode } from "react";
import { Activity, CircleX, TriangleAlert } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Link, type To } from "react-router-dom";
import { Card, CardContent, CardHeader } from "@appstrate/ui/components/card";

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
}: {
  children: ReactNode;
  to?: To;
  onClick?: () => void;
}) {
  const className = cn(
    "text-primary hover:text-primary cursor-pointer rounded-none bg-transparent p-0 text-xs font-normal hover:bg-transparent hover:underline",
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
  children,
}: {
  title: string;
  badge: ReactNode;
  tone: string;
  children: ReactNode;
}) {
  const id = useId();
  const Icon = tone === "blocking" ? CircleX : tone === "warning" ? TriangleAlert : Activity;
  return (
    <Card
      role="region"
      aria-labelledby={id}
      className={cn(
        "bg-muted/35 overflow-hidden",
        tone === "blocking" && "border-destructive/30",
        tone === "warning" && "border-warning/30",
      )}
    >
      <CardHeader className="bg-muted/35 flex-row flex-wrap items-center gap-2 px-4 py-3">
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
      </CardHeader>
      <CardContent className="bg-card overflow-hidden rounded-t-lg border-t p-0">
        {children}
      </CardContent>
    </Card>
  );
}

export function HealthCardItem({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
      </div>
      <div className="flex items-center gap-3 text-xs sm:self-center">{actions}</div>
    </li>
  );
}
