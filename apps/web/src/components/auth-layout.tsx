import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

interface AuthLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function AuthLayout({ children, className }: AuthLayoutProps) {
  return (
    <div className="bg-background relative flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className={cn("w-full max-w-md", className)}>{children}</div>
    </div>
  );
}
