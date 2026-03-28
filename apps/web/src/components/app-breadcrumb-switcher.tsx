import { Check, ChevronsUpDown, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApplications } from "../hooks/use-applications";
import {
  useCurrentApplicationId,
  setCurrentApplicationId,
} from "../hooks/use-current-application";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AppBreadcrumbSwitcher() {
  const { t } = useTranslation();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const currentApp = applications?.find((a) => a.id === currentAppId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 p-0 text-sm text-muted-foreground hover:text-foreground transition-colors">
        {currentApp?.name ?? t("switcher.noApp")}
        <ChevronsUpDown className="size-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {(applications ?? []).map((app) => {
          const isActive = app.id === currentAppId;
          return (
            <DropdownMenuItem
              key={app.id}
              className="flex items-center justify-between gap-2"
              onSelect={() => {
                if (!isActive) setCurrentApplicationId(app.id);
              }}
            >
              <span className="truncate flex items-center gap-1.5">
                {app.name}
                {app.isDefault && (
                  <Star size={12} className="text-amber-500 fill-amber-500 shrink-0" />
                )}
              </span>
              {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
