// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { $api } from "../api/client";
import { useCurrentOrgId } from "../hooks/use-org";
import { useEndUsers } from "../hooks/use-end-users";

/**
 * Schedule execution identity (#738). Exactly one field is set; an empty object
 * (or `undefined`) means "default to the caller" at create time, or "leave
 * unchanged" at edit time. Mirrors the route's `actor` Zod shape.
 */
export type ActorValue = { user_id?: string; end_user_id?: string };

const KIND_MEMBER = "member";
const KIND_END_USER = "end_user";

interface ActorPickerProps {
  value?: ActorValue;
  onChange: (value: ActorValue | undefined) => void;
  /** Label of the identity used when nothing is selected (caller / existing). */
  defaultLabel?: string | null;
}

export function ActorPicker({ value, onChange, defaultLabel }: ActorPickerProps) {
  const { t } = useTranslation(["agents", "common"]);
  const orgId = useCurrentOrgId();

  const { data: orgData } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );
  const members = orgData?.members ?? [];

  const { data: endUserPage } = useEndUsers({ limit: 100 });
  const endUsers = endUserPage?.data ?? [];

  // Kind lives in local state — deriving it from `value` alone would make the
  // end-user option unreachable, since switching kind clears `value` (which
  // would immediately snap the toggle back to "member").
  const [kind, setKind] = useState(value?.end_user_id ? KIND_END_USER : KIND_MEMBER);
  const hasSelection = !!(value?.user_id || value?.end_user_id);

  const handleKindChange = (next: string) => {
    setKind(next);
    onChange(undefined);
  };

  return (
    <div className="space-y-3">
      <Label>{t("schedule.actorTitle")}</Label>
      <p className="text-muted-foreground text-xs">
        {hasSelection
          ? t("schedule.actorHint")
          : t("schedule.actorDefault", { actor: defaultLabel || t("schedule.actorYou") })}
      </p>

      <div className="flex gap-2">
        {/* Identity kind: org member vs. end-user. Switching clears the
            current pick so the two id fields never coexist. */}
        <Select value={kind} onValueChange={handleKindChange}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={KIND_MEMBER}>{t("schedule.actorKindMember")}</SelectItem>
            <SelectItem value={KIND_END_USER}>{t("schedule.actorKindEndUser")}</SelectItem>
          </SelectContent>
        </Select>

        {kind === KIND_MEMBER ? (
          <Select
            value={value?.user_id ?? ""}
            onValueChange={(userId) => onChange({ user_id: userId })}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={t("schedule.actorSelectMember")} />
            </SelectTrigger>
            <SelectContent>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.displayName || m.email || m.userId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={value?.end_user_id ?? ""}
            onValueChange={(endUserId) => onChange({ end_user_id: endUserId })}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={t("schedule.actorSelectEndUser")} />
            </SelectTrigger>
            <SelectContent>
              {endUsers.map((eu) => (
                <SelectItem key={eu.id} value={eu.id}>
                  {eu.name || eu.email || eu.externalId || eu.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
