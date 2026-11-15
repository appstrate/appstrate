// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, UserCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@appstrate/ui/components/command";
import { useOrgDetail } from "../hooks/use-org";
import { roleI18nKey } from "../hooks/use-permissions";
import {
  useBillingManagers,
  useBillingManagersKey,
  useReplaceBillingManagers,
} from "../hooks/use-billing";
import {
  billingManagerCandidates,
  billingManagerRows,
  billingManagersBody,
  eligibleBillingManagers,
  sameBillingManagers,
  type BillingManagerStatus,
} from "../lib/billing-managers";
import { memberLabel } from "../lib/members";
import { ManualSave } from "./settings/manual-save";
import { useSettingDraft } from "../hooks/use-setting-draft";
import { ErrorState } from "./page-states";
import { SettingsSkeleton } from "./loading-skeletons";
import { SectionCard } from "./section-card";

/** What a row the server would now refuse says about itself. */
const STALE_I18N: Record<Exclude<BillingManagerStatus, "eligible">, [string, string]> = {
  role: ["billingManagers.staleRoleBadge", "billingManagers.staleRoleHint"],
  gone: ["billingManagers.staleMemberBadge", "billingManagers.staleMemberHint"],
};

/**
 * Who may act on billing without running the organization (RBAC spec §10).
 *
 * Mounted only where `can("billing:manage")` holds — the exact condition the
 * module's admin routes check, so no query fires for a caller they would 403.
 *
 * A save is a `PUT` of the whole set, so it is refused wholesale over one stale
 * id — a manager since promoted to admin, or since removed from the org. Those
 * rows stay visible, say why, and are dropped from the body: the operator sees
 * the org as it is, and Save cleans it up instead of 400ing on it.
 */
export function BillingManagersSection() {
  const managersQuery = useBillingManagers();
  const orgQuery = useOrgDetail();

  if (managersQuery.isLoading || orgQuery.isLoading) return <SettingsSkeleton rows={1} />;
  if (managersQuery.error) return <ErrorState error={managersQuery.error} />;
  // Without the roster every saved manager reads as gone, so Save would PUT {}.
  if (orgQuery.error) return <ErrorState error={orgQuery.error} />;

  return (
    <BillingManagersForm
      saved={(managersQuery.data?.data ?? []).map((m) => m.userId)}
      members={orgQuery.data?.members ?? []}
    />
  );
}

type OrgMembers = NonNullable<NonNullable<ReturnType<typeof useOrgDetail>["data"]>["members"]>;

function BillingManagersForm({ saved, members }: { saved: string[]; members: OrgMembers }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const managersKey = useBillingManagersKey();
  const replace = useReplaceBillingManagers();
  const [pickerOpen, setPickerOpen] = useState(false);

  const draft = useSettingDraft(saved);
  const selected = draft.value;
  const rows = billingManagerRows(selected, members);
  const candidates = billingManagerCandidates(members).filter((m) => !selected.includes(m.userId));
  // Compared against what the server holds, not against `selected`: a list that
  // only differs by rows the body drops is still a list worth saving.
  const dirty = !sameBillingManagers(eligibleBillingManagers(selected, members), saved);

  const save = async () => {
    const sent = selected;
    const data = await replace.mutateAsync({ body: billingManagersBody(sent, members) });
    queryClient.setQueryData(managersKey, data);
    draft.accept(
      sent,
      data.data.map((m) => m.userId),
    );
    void queryClient.invalidateQueries({ queryKey: managersKey });
  };

  return (
    <SectionCard title={t("billingManagers.title")}>
      <p className="text-muted-foreground text-sm">{t("billingManagers.description")}</p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <UserCog size={16} />
          {t("billingManagers.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const stale = row.status === "eligible" ? null : STALE_I18N[row.status];
            return (
              <li
                key={row.userId}
                className="border-border flex items-center gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.label}</span>
                    {stale && <Badge variant="pending">{t(stale[0])}</Badge>}
                  </span>
                  {row.email && (
                    <span className="text-muted-foreground block truncate text-sm">
                      {row.email}
                    </span>
                  )}
                  {stale && <span className="text-muted-foreground text-sm">{t(stale[1])}</span>}
                </div>
                {!stale && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("billingManagers.removeAriaLabel", { name: row.label })}
                    disabled={replace.isPending}
                    onClick={() => draft.set(selected.filter((id) => id !== row.userId))}
                  >
                    {t("btn.remove", { ns: "common" })}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={replace.isPending}>
              <Plus />
              {t("billingManagers.add")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command>
              <CommandInput
                aria-label={t("billingManagers.searchPlaceholder")}
                placeholder={t("billingManagers.searchPlaceholder")}
              />
              <CommandList>
                <CommandEmpty>{t("billingManagers.noCandidates")}</CommandEmpty>
                {candidates.map((member) => (
                  <CommandItem
                    key={member.userId}
                    disabled={replace.isPending}
                    value={`${memberLabel(member)} ${member.email ?? ""} ${member.userId}`}
                    onSelect={() => {
                      draft.set([...selected, member.userId]);
                      setPickerOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{memberLabel(member)}</span>
                    <Badge variant="pending">{t(roleI18nKey(member.role))}</Badge>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <ManualSave dirty={dirty} onSave={save} onDiscard={draft.reset} />
    </SectionCard>
  );
}
