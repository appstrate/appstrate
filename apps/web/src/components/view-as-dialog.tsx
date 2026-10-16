// SPDX-License-Identifier: Apache-2.0

import { requestScopeChange } from "../hooks/use-unsaved-changes";

import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { VIEW_AS_ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { Field, FieldGroup } from "@appstrate/ui/components/field";
import { FormItem } from "@/components/app-ui/form-item";
import { Label } from "@appstrate/ui/components/label";
import { SelectItem } from "@appstrate/ui/components/select";
import { OptionSelect } from "@/components/app-ui/option-select";
import { FormModal } from "./form-modal";
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
  /** The role whose row opened the dialog: it arrives chosen. */
  preset?: ViewAsPreset | null;
}

/**
 * Entry point for "view as role" — the only place a preview is started. Mounted
 * conditionally by its triggers, so every open starts from its props.
 *
 * The role catalog (`useSpaceRoleOptions`, the server's `validateViewAs` rule) is read
 * HERE with the caller's real permissions: once the preview is on, it is answered AS the
 * persona. Eligibility is the server's call (`view_as_forbidden`).
 */
export function ViewAsDialog({ onClose, spaceId, preset }: ViewAsDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  // A personal space has one member and no roles to preview.
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
  // Grantability is per space; unknown is not empty (nothing to judge against until the catalog lands).
  const roleOption = rolesKnown ? options.find((o) => o.value === roleValue) : undefined;
  const catalogUsable = rolesKnown && !rolesError && options.length > 0;
  const ready = !!orgId && (!inSpace || (!!roleOption && !!space));

  const submit = async () => {
    if (!orgId || !ready || entering) return;
    const persona = toViewAsPersona(orgId, orgRole, space, roleOption);
    setEntering(true);
    try {
      // Load the persona's org row BEFORE committing: permissions and banner appear together,
      // and a failed load must leave the admin where they were.
      const orgs = await fetchOrgsAs(persona);
      // Committing a preview the user already left would persist it, with nothing to undo it.
      if (abandoned.current) return;
      setEntering(false);
      requestScopeChange(() => {
        const moves = !!space && !!roleOption && space.id !== currentSpaceId;
        enterViewAs(persona, orgs, moves ? currentSpaceId : null);
        if (space && roleOption) switchSpace(space.id);
        close();
        if (moves) navigate("/", { replace: true });
        else closeOverlay();
      });
    } catch (err) {
      if (abandoned.current) return;
      setEntering(false);
      // Three of the four refusals are permanent; "try again" fits only an unnamed failure.
      const code = viewAsRefusalCode(err);
      toast.error(code ? t(`viewAs.stopped.${code}`, { ns: "common" }) : t("viewAs.enterFailed"));
      return;
    }
  };

  return (
    <FormModal
      onClose={close}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      title={t("viewAs.trigger")}
      submitLabel={t("viewAs.rowAction")}
      // Not `isPending`: Cancel must stay live while the preview loads, to abandon it.
      submitDisabled={!ready || entering}
      submitTestId="view-as-submit"
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
          <FormItem id="view-as-space" label={t("source.space")}>
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
    </FormModal>
  );
}
