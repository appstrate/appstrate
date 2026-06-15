// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Layers,
  Activity,
  Calendar,
  Wrench,
  Plug,
  Boxes,
  Settings,
  Search,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAgents } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";

/**
 * Global command palette (Cmd/Ctrl+K) mounted once in the sidebar header.
 *
 * Renders the search affordance (full field when expanded, icon when the
 * sidebar is collapsed to its icon rail) plus the dialog. The keyboard
 * shortcut mirrors the sidebar's own Cmd+B handler — registered here so it
 * works regardless of focus.
 */
export function GlobalSearch({ variant = "sidebar" }: { variant?: "sidebar" | "topnav" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { isAdmin } = usePermissions();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const navItems = [
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/agents", label: t("nav.agents"), icon: Layers },
    { path: "/runs", label: t("nav.runs"), icon: Activity },
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/mcp-servers", label: t("nav.mcpServers"), icon: Plug },
    { path: "/integrations", label: t("nav.integrations"), icon: Boxes },
    ...(isAdmin ? [{ path: "/org-settings", label: t("nav.settings"), icon: Settings }] : []),
  ];

  return (
    <>
      {variant === "topnav" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("search.placeholder")}
          className="bg-muted text-muted-foreground hover:bg-accent hidden h-9 w-[220px] items-center gap-2.5 rounded-full px-3.5 text-sm transition-colors lg:flex"
        >
          <Search size={15} className="shrink-0" />
          <span className="flex-1 truncate text-left">{t("search.placeholder")}</span>
          <kbd className="bg-foreground/[0.07] text-muted-foreground pointer-events-none inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[0.7rem] select-none">
            ⌘K
          </kbd>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("search.placeholder")}
          className="border-sidebar-border bg-sidebar text-muted-foreground hover:bg-sidebar-accent flex h-8 w-full items-center gap-2 rounded-md border px-2 text-sm transition-colors"
        >
          <Search size={16} className="shrink-0" />
          <span className="flex-1 truncate text-left">{t("search.placeholder")}</span>
          <kbd className="bg-muted text-muted-foreground pointer-events-none hidden h-5 items-center gap-0.5 rounded border px-1.5 font-mono text-[0.65rem] font-medium select-none sm:inline-flex">
            ⌘K
          </kbd>
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0 [&>button:last-child]:hidden">
          <DialogTitle className="sr-only">{t("search.placeholder")}</DialogTitle>
          <Command>
            <CommandInput placeholder={t("search.placeholder")} />
            <CommandList>
              <CommandEmpty>{t("search.empty")}</CommandEmpty>
              <CommandGroup heading={t("search.navigation")}>
                {navItems.map((item) => (
                  <CommandItem
                    key={item.path}
                    value={item.label}
                    onSelect={() => go(item.path)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {agents && agents.length > 0 && (
                <CommandGroup heading={t("nav.agents")}>
                  {agents.map((agent) => (
                    <CommandItem
                      key={agent.id}
                      value={`${agent.display_name} ${agent.id}`}
                      onSelect={() => go(`/agents/${agent.id}`)}
                    >
                      <Layers />
                      <span className="truncate">{agent.display_name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
