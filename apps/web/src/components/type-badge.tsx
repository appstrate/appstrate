import { cn } from "@/lib/utils";
import type { PackageType } from "@appstrate/shared-types";

const typeColorMap: Record<string, string> = {
  flow: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  skill: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  tool: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  provider: "bg-green-500/20 text-green-400 border-green-500/30",
};

export function TypeBadge({ type }: { type: PackageType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        typeColorMap[type],
      )}
    >
      {type}
    </span>
  );
}
