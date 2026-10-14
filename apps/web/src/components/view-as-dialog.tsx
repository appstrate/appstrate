// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { VIEW_AS_ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { Button } from "@appstrate/ui/components/button";
import { Field, FieldGroup, FormItem } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import { OptionSelect, SelectItem } from "@appstrate/ui/components/select";
import { Modal } from "./modal";
import { OrgRoleOptions } from "./org-role-options";
import { RoleCatalogState } from "./role-catalog-state";
import { fetchOrgsAs, useCurrentOrgId } from "../hooks/use-org";
import { useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import { spaceLabel } from "../lib/space-label";
import { useSpaces } from "../hooks/use-spaces";
import { useSpaceRoleOptions } from "../hooks/use-roles";
import { useCloseOverlay } from "../lib/modal-route";
import { enterViewAs, toViewAsPersona } from "../stores/view-as-store";
import { viewAsRefusalCode } from "../lib/view-as-refusal";
import {
  VIEW_AS_NO_SPACE,
  viewAsRoleValue,
  viewAsSpace,
  type ViewAsPreset,
} from "../lib/view-as-preset";

/** A chosen value reads as chosen: the global `button` base would grey it like a placeholder. */
const CHOSEN_VALUE = "text-foreground data-[placeholder]:text-muted-foreground";

interface ViewAsDialogProps {
  onClose: () => void;
  /** Space the trigger is about. Defaults to the space the user is in. */
  spaceId?: string;
  /** The role whose row opened the dialog: it arrives chosen (`?viewAs=<kind>:<key>`). */
  preset?: ViewAsPreset | null;
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
export function ViewAsDialog({ onClose, spaceId, preset }: ViewAsDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  // A personal space has one member and no roles to preview: nobody else can
  // ever stand in it.
  const { data: allSpaces } = useSpaces();
  const spaces = allSpaces?.filter((s) => !s.personal);
  const navigate = useNavigate();
  const closeOverlay = useCloseOverlay();

  const [orgRole, setOrgRole] = useState<ViewAsOrgRole>(
    preset?.kind === "org" ? preset.role : "member",
  );
  /** `null` follows the preset (`viewAsSpace`, `viewAsRoleValue`); a pick, even "none", wins. */
  const [pickedSpaceId, setPickedSpaceId] = useState<string | null>(null);
  const [pickedRole, setPickedRole] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  /** A closed or unmounted dialog must never commit a pending preview. */
  const abandoned = useRef(false);
  useLayoutEffect(() => {
    // Reset for StrictMode's setup/cleanup replay. Layout cleanup marks an
    // unmount before any pending promise continuation can apply its response.
    abandoned.current = false;
    return () => {
      abandoned.current = true;
    };
  }, []);

  /** The one exit: whatever closed the dialog, the preview it started is off. */
  const close = () => {
    abandoned.current = true;
    onClose();
  };

  const { spaceId: selectedSpaceId, presetRoleKey } = viewAsSpace({
    preset,
    homeSpaceId: spaceId ?? currentSpaceId,
    spaces,
    pickedSpaceId,
  });
  const inSpace = selectedSpaceId !== VIEW_AS_NO_SPACE;
  const {
    options,
    roles,
    rolesKnown,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useSpaceRoleOptions(inSpace ? selectedSpaceId : undefined, inSpace);
  const space = spaces?.find((s) => s.id === selectedSpaceId);
  const roleValue = viewAsRoleValue(presetRoleKey, pickedRole, roles);
  // Grantability is per space, so the catalog is what says whether this pair is
  // previewable. Unknown is not empty: until the catalog lands there is nothing
  // to judge the choice against.
  const roleOption = rolesKnown ? options.find((o) => o.value === roleValue) : undefined;
  const catalogUsable = rolesKnown && !rolesError && options.length > 0;
  const ready = !!orgId && (!inSpace || (!!roleOption && !!space));

  const submit = async () => {
    if (!orgId || !ready || entering) return;
    // Replaces any preview already running: the store commits one persona and
    // resets the cache either way.
    const persona = toViewAsPersona(orgId, orgRole, space, roleOption);
    setEntering(true);
    try {
      // Load the persona's own org row BEFORE committing it: the permissions
      // and the banner must appear together, and a load that fails must leave
      // the admin exactly where they were rather than under a persona wearing
      // their own authority.
      const orgs = await fetchOrgsAs(persona);
      // Committing a preview the user already left would persist it, and a
      // persona the server accepts is never stopped later: nothing would undo it.
      if (abandoned.current) return;
      // Only a preview that moves the admin has a space to bring them back to.
      const moves = !!space && !!roleOption && space.id !== currentSpaceId;
      enterViewAs(persona, orgs, moves ? currentSpaceId : null);
    } catch (err) {
      if (abandoned.current) return;
      setEntering(false);
      // Three of the four refusals are permanent; "try again" is only ever true
      // of a failure the server named nothing for.
      const code = viewAsRefusalCode(err);
      toast.error(code ? t(`viewAs.stopped.${code}`, { ns: "common" }) : t("viewAs.enterFailed"));
      return;
    }
    // Land where the persona's role applies. Elsewhere the persona is only its
    // org role — an implicit member of open spaces — and a banner naming
    // "Lecteur dans Default" over a page answered for another space reads as
    // a preview that does not work.
    const movesSpace = !!space && !!roleOption && space.id !== currentSpaceId;
    if (space && roleOption) switchSpace(space.id);
    // The settings overlay this was opened in goes with it: the preview is for
    // looking at the app. Back to the screen the overlay covered, unless the
    // space changed under it (that screen belongs to the other space): home.
    close();
    if (movesSpace) navigate("/", { replace: true });
    else closeOverlay();
  };

  return (
    <Modal
      open
      onClose={close}
      title={t("viewAs.title")}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button
            data-testid="view-as-submit"
            disabled={!ready || entering}
            onClick={() => void submit()}
          >
            {t("viewAs.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("viewAs.explain")}</p>

        <OrgRoleOptions
          idPrefix="view-as"
          // The two the server accepts: previewing `owner`/`admin` removes nothing.
          options={VIEW_AS_ORG_ROLES}
          value={orgRole}
          onValueChange={(value) => setOrgRole(value as ViewAsOrgRole)}
        />

        <FieldGroup>
          <FormItem id="view-as-space" label={t("viewAs.spaceLabel")}>
            <OptionSelect
              value={selectedSpaceId}
              onValueChange={(value) => {
                setPickedSpaceId(value);
                setPickedRole(null);
              }}
              className={CHOSEN_VALUE}
              leading={<SelectItem value={VIEW_AS_NO_SPACE}>{t("viewAs.noSpace")}</SelectItem>}
              options={(spaces ?? []).map((s) => ({ value: s.id, label: spaceLabel(s, t) }))}
            />
          </FormItem>

          {inSpace && (
            <Field>
              <Label htmlFor="view-as-space-role">{t("viewAs.spaceRoleLabel")}</Label>
              {catalogUsable ? (
                <OptionSelect
                  id="view-as-space-role"
                  value={roleValue || undefined}
                  onValueChange={setPickedRole}
                  className={CHOSEN_VALUE}
                  placeholder={t("viewAs.spaceRolePlaceholder")}
                  options={options}
                />
              ) : (
                <RoleCatalogState
                  isLoading={rolesLoading}
                  rolesKnown={rolesKnown}
                  error={rolesError}
                  refetch={() => void refetchRoles()}
                  emptyMessage={t("viewAs.rolesEmpty")}
                />
              )}
            </Field>
          )}
        </FieldGroup>
      </div>
    </Modal>
  );
}
