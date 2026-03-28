import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, Plus } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-medium",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { isMobile } = useSidebar();

  if (loading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (!currentOrg) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={t("switcher.orgAriaLabel")}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <OrgAvatar name={currentOrg.name} className="aspect-square size-8 text-sm" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{currentOrg.name}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("switcher.orgAriaLabel")}
            </DropdownMenuLabel>
            {orgs.map((org) => {
              const isActive = org.id === currentOrg.id;
              return (
                <DropdownMenuItem
                  key={org.id}
                  className="flex items-center gap-2"
                  onSelect={() => {
                    if (!isActive) switchOrg(org.id);
                  }}
                >
                  <OrgAvatar name={org.name} className="size-6 rounded-md text-xs" />
                  <span className="truncate flex-1">{org.name}</span>
                  {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/onboarding/create"
                state={{ fromSwitcher: true }}
                className="flex items-center gap-2 text-primary"
              >
                <Plus size={14} />
                {t("switcher.createOrg")}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
