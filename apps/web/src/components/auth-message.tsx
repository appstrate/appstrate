// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";

const AUTH_LINK_CLASS =
  "text-muted-foreground hover:text-primary text-sm underline underline-offset-4";

type AuthLinkProps = Omit<ComponentProps<"button">, "type"> & { to?: string };

/** The quiet underlined link of the auth screens: a route when `to` is given, else a button. */
export function AuthLink({ to, className, ...props }: AuthLinkProps) {
  const classes = cn(AUTH_LINK_CLASS, className);
  if (to !== undefined) {
    return (
      <Link to={to} className={classes}>
        {props.children}
      </Link>
    );
  }
  return <button type="button" {...props} className={classes} />;
}

interface AuthMessageProps {
  icon: LucideIcon;
  /** Heading; omit when `description` alone carries the message. */
  title?: string;
  description?: ReactNode;
  tone?: "primary" | "destructive";
  /** Extra content between the text and the back link. */
  children?: ReactNode;
  backTo?: string;
  backLabel?: string;
}

/** An auth screen's outcome: an icon tile, a message, what to do next, the way back. */
export function AuthMessage({
  icon: Icon,
  title,
  description,
  tone = "primary",
  children,
  backTo,
  backLabel,
}: AuthMessageProps) {
  const destructive = tone === "destructive";
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div
        className={cn(
          "flex h-16 w-16 items-center justify-center rounded-full",
          destructive ? "bg-destructive/10" : "bg-primary/10",
        )}
      >
        <Icon className={cn("h-8 w-8", destructive ? "text-destructive" : "text-primary")} />
      </div>
      {(title || description) && (
        <div className="flex flex-col gap-2">
          {title && <h1 className="text-2xl font-semibold">{title}</h1>}
          {description && <div className="text-muted-foreground text-sm">{description}</div>}
        </div>
      )}
      {children}
      {backTo && backLabel && <AuthLink to={backTo}>{backLabel}</AuthLink>}
    </div>
  );
}
