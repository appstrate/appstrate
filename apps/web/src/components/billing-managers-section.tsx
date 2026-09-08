// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, UserCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@appstrate/ui/components/command";
import { getErrorMessage } from "@appstrate/core/errors";
import { $api } from "../api/client";
import { useCurrentOrgId } from "../hooks/use-org";
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
  memberLabel,
  sameBillingManagers,
  type BillingManagerStatus,
} from "../lib/billing-managers";
import { LoadingState, ErrorState } from "./page-states";
import { SectionCard } from "./section-card";
import { Spinner } from "./spinner";

/** What a row the server would now refuse says about itself. */
const STALE_I18N: Record<Exclude<BillingManagerStatus, "eligible">, [string, string]> = {
  role: ["billingManagers.staleRoleBadge", "billingManagers.staleRoleHint"],
  gone: ["billingManagers.staleMemberBadge", "billingManagers.staleMemberHint"],
};

/**
 * Who may act on billing without running the organization (RBAC spec §10).
 *
 * Mounted only where `features.billing && can("billing:manage")` holds — the
 * exact condition the module's routes check.
 *
 * A save is a `PUT` of the whole set, so it is refused wholesale over one stale
 * id — a manager since promoted to admin, or since removed from the org. Those
 * rows stay visible, say why, and are dropped from the body: the operator sees
 * the org as it is, and Save cleans it up instead of 400ing on it.
 */
export function BillingManagersSection() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const orgId = useCurrentOrgId();
  const managersQuery = useBillingManagers();
  const managersKey = useBillingManagersKey();
  const replace = useReplaceBillingManagers();
  const [pickerOpen, setPickerOpen] = useState(false);

  // The same read the members page uses, with the same init — so the two share
  // one cache entry instead of fetching the org twice.
  const orgQuery = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );

  // `null` while the section shows exactly what the server holds; an array as
  // soon as the operator has edited the list. Derived rather than mirrored into
  // an effect, so a refetch cannot silently overwrite an unsaved edit.
  const [draft, setDraft] = useState<string[] | null>(null);

  if (managersQuery.isLoading || orgQuery.isLoading) return <LoadingState />;
  if (managersQuery.error) return <ErrorState message={getErrorMessage(managersQuery.error)} />;
  // Without the roster every saved manager reads as "no longer a member", which
  // makes the list dirty and turns Save into a PUT of the empty set.
  if (orgQuery.error) return <ErrorState message={getErrorMessage(orgQuery.error)} />;

  const saved = (managersQuery.data?.managers ?? []).map((m) => m.user_id);
  const selected = draft ?? saved;
  const members = orgQuery.data?.members ?? [];
  const rows = billingManagerRows(selected, members);
  const candidates = billingManagerCandidates(members).filter((m) => !selected.includes(m.userId));
  // Compared against what the server holds, not against `selected`: a list that
  // only differs by rows the body drops is still a list worth saving.
  const dirty = !sameBillingManagers(eligibleBillingManagers(selected, members), saved);

  const handleSave = () => {
    replace.mutate(
      { body: billingManagersBody(selected, members) },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(managersKey, data);
          setDraft(null);
          void queryClient.invalidateQueries({ queryKey: managersKey });
          toast.success(t("billingManagers.saveSuccess"));
        },
        onError: (err) =>
          toast.error(t("error.prefix", { ns: "common", message: getErrorMessage(err) })),
      },
    );
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
                    onClick={() => setDraft(selected.filter((id) => id !== row.userId))}
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
              <Plus size={16} />
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
                      setDraft([...selected, member.userId]);
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

      <div className="flex justify-end gap-2">
        {draft !== null && (
          <Button
            variant="outline"
            size="sm"
            disabled={replace.isPending}
            onClick={() => setDraft(null)}
          >
            {t("btn.cancel", { ns: "common" })}
          </Button>
        )}
        <Button size="sm" disabled={!dirty || replace.isPending} onClick={handleSave}>
          {replace.isPending && <Spinner />}
          {t("btn.save", { ns: "common" })}
        </Button>
      </div>
    </SectionCard>
  );
}
