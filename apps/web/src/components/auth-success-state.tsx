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
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-8 w-8 text-primary" />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Link
        to={backTo}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
      >
        {backLabel}
      </Link>
    </div>
  );
}
