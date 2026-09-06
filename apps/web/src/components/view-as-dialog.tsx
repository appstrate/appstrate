// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@appstrate/core/errors";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Field, FieldGroup } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Modal } from "./modal";
import { OrgRoleOptions } from "./org-role-options";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useSpaces } from "../hooks/use-spaces";
import { useSpaceRoleOptions } from "../hooks/use-roles";
import { enterViewAs, toViewAsPersona } from "../stores/view-as-store";

/** The two the server accepts: previewing `owner`/`admin` would remove nothing. */
const PERSONA_ORG_ROLES = ["member", "guest"] as const;

type PersonaOrgRole = (typeof PERSONA_ORG_ROLES)[number];

/** "No space" option. Not the empty string — Radix refuses an empty item value. */
const NO_SPACE = "none";

interface ViewAsDialogProps {
  onClose: () => void;
  /** Space the trigger is about. Defaults to the space the user is in. */
  spaceId?: string;
  /** Space-role value (`preset:…` / `custom:…`) to preselect, from the row clicked. */
  role?: string;
}

/**
 * Entry point for "view as role" — the only place a preview is started.
 *
 * Mounted conditionally by its triggers (like `RoleFormModal`), so every open
 * starts from the props it was given rather than from the last visit's state.
 *
 * The role catalog comes from `useSpaceRoleOptions(spaceId)`, the same
 * grantability rule the server applies in `validateViewAs`, read HERE with the
 * caller's real permissions: once the preview is on, that catalog is answered
 * AS the persona and no longer says what the admin may preview.
 *
 * Eligibility is not decided here — the triggers show only for an owner or an
 * administrator, and the server refuses anyone else (`view_as_forbidden`).
 */
export function ViewAsDialog({ onClose, spaceId, role }: ViewAsDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();

  const initialSpaceId = spaceId ?? currentSpaceId ?? NO_SPACE;
  const [orgRole, setOrgRole] = useState<PersonaOrgRole>("member");
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSpaceId);
  // A role preselected by the trigger only means something inside a space. With
  // none resolved, the select opens on its placeholder rather than committing a
  // persona the user never saw.
  const [roleValue, setRoleValue] = useState(initialSpaceId === NO_SPACE ? "" : (role ?? ""));

  const inSpace = selectedSpaceId !== NO_SPACE;
  const {
    options,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(inSpace ? selectedSpaceId : undefined, inSpace);
  const space = spaces?.find((s) => s.id === selectedSpaceId);
  // Grantability is per space, so the catalog — not the carried-over value — is
  // what says whether this pair is previewable. Unknown is not empty: until the
  // catalog lands there is nothing to judge the choice against.
  const roleOption = rolesKnown ? options.find((o) => o.value === roleValue) : undefined;
  const ready = !!orgId && (!inSpace || (!!roleOption && !!space));

  const submit = () => {
    if (!orgId || !ready) return;
    // Replaces any preview already running: the store commits one persona and
    // resets the cache either way.
    enterViewAs(toViewAsPersona(orgId, orgRole, space, roleOption));
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("viewAs.title")}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button data-testid="view-as-submit" disabled={!ready} onClick={submit}>
            {t("viewAs.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("viewAs.explain")}</p>

        <OrgRoleOptions
          idPrefix="view-as"
          options={PERSONA_ORG_ROLES}
          value={orgRole}
          onValueChange={(value) => setOrgRole(value as PersonaOrgRole)}
        />

        <FieldGroup>
          <Field>
            <Label htmlFor="view-as-space">{t("viewAs.spaceLabel")}</Label>
            <Select
              value={selectedSpaceId}
              onValueChange={(value) => {
                setSelectedSpaceId(value);
                setRoleValue("");
              }}
            >
              <SelectTrigger id="view-as-space">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SPACE}>{t("viewAs.noSpace")}</SelectItem>
                {(spaces ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {inSpace && (
            <Field>
              <Label htmlFor="view-as-space-role">{t("viewAs.spaceRoleLabel")}</Label>
              {rolesError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    <p>{getErrorMessage(rolesError)}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refetchRoles()}
                    >
                      {t("btn.retry", { ns: "common" })}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : rolesLoading || !rolesKnown ? (
                <p role="status" className="text-muted-foreground text-sm">
                  {t("spaceMembers.rolesLoading")}
                </p>
              ) : options.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("viewAs.rolesEmpty")}</p>
              ) : (
                <Select value={roleValue || undefined} onValueChange={setRoleValue}>
                  <SelectTrigger id="view-as-space-role">
                    <SelectValue placeholder={t("viewAs.spaceRolePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          )}
        </FieldGroup>
      </div>
    </Modal>
  );
}
