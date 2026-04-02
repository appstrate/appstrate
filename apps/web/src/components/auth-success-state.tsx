// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

interface AuthSuccessStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  backTo: string;
  backLabel: string;
}

export function AuthSuccessState({
  icon: Icon,
  title,
  description,
  backTo,
  backLabel,
}: AuthSuccessStateProps) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-full">
        <Icon className="text-primary h-8 w-8" />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      <Link
        to={backTo}
        className="text-muted-foreground hover:text-primary text-sm underline underline-offset-4"
      >
        {backLabel}
      </Link>
    </div>
  );
}
