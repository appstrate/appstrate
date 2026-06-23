// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { $api } from "../api/client";
import { useCurrentOrgId } from "../hooks/use-org";
import { useEndUsers, useEndUser } from "../hooks/use-end-users";

/**
 * An execution identity. Exactly one field is set; `undefined` means no
 * selection. Mirrors the platform `actor` wire shape (user XOR end-user).
 */
export type ActorValue = { user_id?: string; end_user_id?: string };

interface ActorSelectProps {
  value?: ActorValue;
  onChange: (value: ActorValue | undefined) => void;
  /** Trigger label shown when nothing is selected. */
  placeholder?: string;
  /** Include end-users in the list. Defaults to true. */
  includeEndUsers?: boolean;
  disabled?: boolean;
}

interface Option {
  actor: ActorValue;
  name: string;
  email: string | null;
}

/** Primary line for an option — name, falling back to email then id. */
function primaryLabel(name: string | null | undefined, email: string | null, id: string): string {
  return name || email || id;
}

/**
 * Unified, searchable actor picker. Lists org members and end-users in one
 * combobox so a single field selects either kind. Reusable anywhere an
 * execution identity is chosen (#738). End-users are searched server-side
 * (debounced) so large tenants aren't capped; members are filtered in-memory.
 */
export function ActorSelect({
  value,
  onChange,
  placeholder,
  includeEndUsers = true,
  disabled,
}: ActorSelectProps) {
  const { t } = useTranslation(["agents", "common"]);
  const orgId = useCurrentOrgId();
  const [open, setOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: orgData } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );
  const members = useMemo(() => orgData?.members ?? [], [orgData]);

  const { data: endUserPage } = useEndUsers({
    limit: 50,
    search: debouncedQuery || undefined,
  });
  const endUsers = useMemo(
    () => (includeEndUsers ? (endUserPage?.data ?? []) : []),
    [includeEndUsers, endUserPage],
  );

  const memberOptions = useMemo<Option[]>(() => {
    const q = debouncedQuery.toLowerCase();
    return members
      .filter(
        (m) =>
          !q ||
          (m.displayName ?? "").toLowerCase().includes(q) ||
          (m.email ?? "").toLowerCase().includes(q),
      )
      .map((m) => ({
        actor: { user_id: m.userId },
        name: primaryLabel(m.displayName, m.email ?? null, m.userId),
        email: m.email ?? null,
      }));
  }, [members, debouncedQuery]);

  const endUserOptions = useMemo<Option[]>(
    () =>
      endUsers.map((eu) => ({
        actor: { end_user_id: eu.id },
        name: primaryLabel(eu.name, eu.email, eu.externalId || eu.id),
        email: eu.email,
      })),
    [endUsers],
  );

  // Resolve the selected end-user's label even when it isn't in the current
  // search page (the trigger must show it regardless of the active query).
  const selectedEndUserInList = endUsers.some((eu) => eu.id === value?.end_user_id);
  const { data: selectedEndUser } = useEndUser(
    !selectedEndUserInList && value?.end_user_id ? value.end_user_id : "",
  );

  const selectedLabel = useMemo(() => {
    if (value?.user_id) {
      const m = members.find((mm) => mm.userId === value.user_id);
      if (m) return primaryLabel(m.displayName, m.email ?? null, m.userId);
      return value.user_id;
    }
    if (value?.end_user_id) {
      const inList = endUsers.find((eu) => eu.id === value.end_user_id);
      if (inList) return primaryLabel(inList.name, inList.email, inList.externalId || inList.id);
      if (selectedEndUser) {
        return primaryLabel(
          selectedEndUser.name,
          selectedEndUser.email,
          selectedEndUser.externalId || selectedEndUser.id,
        );
      }
      return value.end_user_id;
    }
    return null;
  }, [value, members, endUsers, selectedEndUser]);

  const select = (actor: ActorValue) => {
    onChange(actor);
    setOpen(false);
    setQuery("");
  };

  const isActive = (actor: ActorValue) =>
    (actor.user_id && actor.user_id === value?.user_id) ||
    (actor.end_user_id && actor.end_user_id === value?.end_user_id);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selectedLabel ?? placeholder ?? t("actorSelect.placeholder")}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        {/* shouldFilter disabled — members are filtered in-memory and end-users
            server-side, so cmdk must not re-filter the rendered items. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("actorSelect.search")}
          />
          <CommandList>
            <CommandEmpty>{t("actorSelect.empty")}</CommandEmpty>
            {memberOptions.length > 0 && (
              <CommandGroup heading={t("actorSelect.groupMembers")}>
                {memberOptions.map((o) => (
                  <CommandItem
                    key={`u:${o.actor.user_id}`}
                    value={`u:${o.actor.user_id}`}
                    onSelect={() => select(o.actor)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        isActive(o.actor) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{o.name}</span>
                      {o.email && o.email !== o.name && (
                        <span className="text-muted-foreground truncate text-xs">{o.email}</span>
                      )}
                    </div>
                    <Badge variant="secondary" className="ml-auto shrink-0 text-[0.65rem]">
                      {t("actorSelect.badgeMember")}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {endUserOptions.length > 0 && (
              <CommandGroup heading={t("actorSelect.groupEndUsers")}>
                {endUserOptions.map((o) => (
                  <CommandItem
                    key={`e:${o.actor.end_user_id}`}
                    value={`e:${o.actor.end_user_id}`}
                    onSelect={() => select(o.actor)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        isActive(o.actor) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{o.name}</span>
                      {o.email && o.email !== o.name && (
                        <span className="text-muted-foreground truncate text-xs">{o.email}</span>
                      )}
                    </div>
                    <Badge variant="secondary" className="ml-auto shrink-0 text-[0.65rem]">
                      {t("actorSelect.badgeEndUser")}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
