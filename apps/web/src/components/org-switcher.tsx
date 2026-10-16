// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Plus, Star } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@appstrate/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useSidebar } from "@appstrate/ui/components/sidebar";
import { cn } from "@appstrate/ui/cn";
import { useLandAfterOrgSwitch } from "../lib/modal-route";
import { useOrg } from "../hooks/use-org";
import { useOrgSpaces, useSpaces } from "../hooks/use-spaces";
import { usePermissions } from "../hooks/use-permissions";
import { isSpaceEnterable, useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import { useCanCreateOrg } from "../hooks/use-auth";
import { spaceLabel } from "../lib/space-label";
import { spaceStore } from "../stores/space-store";
import { OrganizationAvatar } from "./organization-avatar";
import { NEW_SPACE_PARAM } from "./space-create-modal";

/** Exploring an organization never changes authority: choosing a workspace applies both. */
export function OrgSwitcher({ variant }: { variant: "brand" | "mobile" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const landAfterOrgSwitch = useLandAfterOrgSwitch();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { data: spaces, isPending: spacesPending } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const { setOpenMobile } = useSidebar();
  const { can } = usePermissions();
  const canCreateOrg = useCanCreateOrg();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [exploredOrgId, setExploredOrgId] = useState<string | null>(null);
  const exploredId = exploredOrgId ?? currentOrg?.id ?? null;
  const exploredSpaces = useOrgSpaces(open ? exploredId : null);
  const currentSpace = spaces?.find((space) => space.id === currentSpaceId);
  const close = () => {
    setOpen(false);
    setExploredOrgId(null);
    setQuery("");
    setOpenMobile(false);
  };
  const applyContext = (spaceId: string) => {
    if (!currentOrg || !exploredId) return;
    if (exploredId !== currentOrg.id) {
      spaceStore.getState().remember(exploredId, spaceId);
      switchOrg(exploredId);
      landAfterOrgSwitch();
    } else switchSpace(spaceId);
    close();
  };

  if (loading) return <Skeleton className="h-9 w-full" />;
  if (!currentOrg) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setExploredOrgId(null);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          data-testid="org-switcher-button"
          aria-label={t("switcher.orgAriaLabel")}
          className={cn(
            "min-w-0 justify-start px-1.5 font-normal",
            variant === "brand" ? "h-9 w-full" : "h-11 flex-1",
          )}
        >
          <OrganizationAvatar org={currentOrg} className="size-6 shrink-0 rounded-md" />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="font-semibold">{currentOrg.name}</span>
            <span className="text-muted-foreground">
              {currentSpace ? (
                ` · ${spaceLabel(currentSpace, t)}`
              ) : spacesPending ? (
                <Skeleton className="ml-2 inline-block h-3.5 w-16" />
              ) : null}
            </span>
          </span>
          <ChevronsUpDown className="text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("switcher.searchPlaceholder")}
            aria-label={t("switcher.searchAriaLabel")}
          />
          <CommandList>
            <CommandEmpty>{t("switcher.workspacesEmpty")}</CommandEmpty>
            <CommandGroup heading={t("switcher.orgsColumn")}>
              {orgs.map((org) => (
                <CommandItem
                  key={org.id}
                  value={`org-${org.id}`}
                  keywords={[org.name]}
                  data-testid={`org-item-${org.id}`}
                  aria-expanded={org.id === exploredId}
                  onSelect={() => {
                    setExploredOrgId(org.id);
                    setQuery("");
                  }}
                >
                  <OrganizationAvatar org={org} className="size-6 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  {org.id === exploredId && <Check className="text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            {exploredSpaces.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
              </div>
            ) : exploredSpaces.isError ? (
              <p role="alert" className="text-destructive p-3 text-sm">
                {t("error.generic")}
              </p>
            ) : (
              [true, false].map((personal) => (
                <CommandGroup
                  key={String(personal)}
                  heading={t(personal ? "spaces.personal.badge" : "spaces.personal.teamGroup", {
                    ns: "settings",
                  })}
                >
                  {(exploredSpaces.data ?? [])
                    .filter((space) => Boolean(space.personal) === personal)
                    .map((space) => {
                      const enterable = isSpaceEnterable(space);
                      return (
                        <CommandItem
                          key={space.id}
                          value={`space-${space.id}`}
                          keywords={[spaceLabel(space, t)]}
                          data-testid={`space-item-${space.id}`}
                          disabled={!enterable}
                          title={
                            enterable ? undefined : t("spaces.requestAccess", { ns: "settings" })
                          }
                          onSelect={() => applyContext(space.id)}
                        >
                          <span className="min-w-0 flex-1 truncate">{spaceLabel(space, t)}</span>
                          {space.isDefault && <Star className="fill-warning text-warning" />}
                          {!enterable && (
                            <span className="text-muted-foreground text-xs">
                              {t("switcher.spaceOnRequest")}
                            </span>
                          )}
                          {space.id === currentSpaceId && exploredId === currentOrg.id && (
                            <Check className="text-primary" />
                          )}
                        </CommandItem>
                      );
                    })}
                </CommandGroup>
              ))
            )}
            <CommandSeparator />
            <CommandGroup>
              {canCreateOrg && (
                <CommandItem
                  onSelect={() => {
                    close();
                    navigate("/onboarding/create", { state: { fromSwitcher: true } });
                  }}
                >
                  <Plus />
                  {t("switcher.createOrg")}
                </CommandItem>
              )}
              {exploredId === currentOrg.id && can("spaces:write") && (
                <CommandItem
                  onSelect={() => {
                    close();
                    navigate(`/org-settings/spaces?${NEW_SPACE_PARAM}=1`);
                  }}
                >
                  <Plus />
                  {t("spaces.create", { ns: "settings" })}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
