// SPDX-License-Identifier: Apache-2.0

import { useImperativeHandle, type Ref } from "react";
import { toast } from "sonner";
import { useAssignmentCatalog } from "../hooks/use-assignment-catalog";
import { spaceRoleValue } from "../hooks/use-roles";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Controller, useForm, useWatch } from "react-hook-form";
import { ORG_ROLES } from "@appstrate/core/permissions";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { FieldError, FieldGroup, FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import type { components } from "../api/client";
import { useInviteMember, useUpdateInvitation } from "../hooks/use-org";
import { OrgRoleOptions } from "./org-role-options";
import {
  hasUnavailableAssignments,
  assignmentsFor,
  toSpaceAssignments,
  type AssignmentDraft,
} from "../lib/space-assignments";
import { SpaceAssignmentsField } from "./space-assignments-field";
import { Spinner } from "@appstrate/ui/components/spinner";
import { errorMessage } from "../lib/mutation-error";

interface InviteFormValues {
  email: string;
  role: AssignableOrgRole;
  assignments: AssignmentDraft[];
}

export interface OrgInvitationFormHandle {
  /**
   * Invite the email still typed in the field — a new invitation, never an edit of
   * `invitation`. Resolves `true` once sent or when the field is blank; `false` while
   * an invite is in flight, or when the value is invalid or the invite fails, the
   * form then showing why.
   */
  submitPending: () => Promise<boolean>;
}

/**
 * The same invitation flow in onboarding and organization settings. Remount on
 * org change. `allowGuest` offers the guest role on a NEW invitation (spaces
 * then required); onboarding leaves it off, an org has no shared spaces yet.
 * Editing always offers every role.
 */
export function OrgInvitationForm({
  orgId,
  invitation,
  allowGuest = false,
  onSuccess,
  onCancel,
  ref,
}: {
  orgId: string;
  invitation?: components["schemas"]["OrgInvitationInfo"];
  allowGuest?: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
  ref?: Ref<OrgInvitationFormHandle>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const catalog = useAssignmentCatalog();
  const form = useForm<InviteFormValues>({
    defaultValues: {
      email: invitation?.email ?? "",
      // Invitations cannot grant ownership; the API enforces AssignableOrgRole.
      role: (invitation?.role ?? "member") as AssignableOrgRole,
      assignments: (invitation?.space_assignments ?? []).map((assignment) => ({
        spaceId: assignment.spaceId,
        role: spaceRoleValue(assignment),
      })),
    },
  });
  const role = useWatch({ control: form.control, name: "role" });
  const onError = (error: unknown) => form.setError("root", { message: errorMessage(error) });
  const complete = (message: string) => {
    toast.success(message);
    form.reset();
    onSuccess?.();
  };
  const invite = useInviteMember();
  const update = useUpdateInvitation();
  const inviteOutcome = (email: string) => ({
    onSuccess: () => complete(t("orgSettings.inviteSuccess", { email })),
    onError,
  });
  const isPending = invite.isPending || update.isPending;
  const fieldPrefix = invitation ? "edit-invite" : "invite";
  const bodyOf = (data: InviteFormValues) => ({
    role: data.role,
    space_assignments: assignmentsFor(data.role, toSpaceAssignments(data.assignments)),
  });
  const inviteRequest = (data: InviteFormValues) => ({
    params: { path: { orgId } },
    body: { ...bodyOf(data), email: data.email.trim() },
  });

  useImperativeHandle(ref, () => ({
    submitPending: async () => {
      if (invite.isPending) return false;
      if (!form.getValues("email").trim()) return true;
      if (!(await form.trigger())) return false;
      // The hook's `onError` already shows a refusal on the form.
      const request = inviteRequest(form.getValues());
      return invite.mutateAsync(request, inviteOutcome(request.body.email)).then(
        () => true,
        () => false,
      );
    },
  }));

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((data) => {
        if (invitation) {
          update.mutate(
            {
              params: { path: { orgId, invitationId: invitation.id } },
              body: bodyOf(data),
            },
            { onSuccess: () => complete(t("orgSettings.inviteUpdated")), onError },
          );
        } else {
          const request = inviteRequest(data);
          invite.mutate(request, inviteOutcome(request.body.email));
        }
      })}
      className="flex flex-col gap-4"
    >
      <FieldGroup>
        <FormItem
          id={`${fieldPrefix}-email`}
          label={t("orgSettings.inviteEmailAriaLabel")}
          error={form.formState.errors.email?.message}
        >
          <Input
            type="email"
            readOnly={!!invitation}
            autoComplete="email"
            placeholder="email@example.com"
            disabled={isPending}
            {...form.register("email", {
              required: t("common:validation.required"),
              setValueAs: (value: string) => value.trim(),
              validate: (value) =>
                z.email().safeParse(value).success || t("common:validation.emailFormat"),
            })}
          />
        </FormItem>
        <OrgRoleOptions
          idPrefix={fieldPrefix}
          disabled={isPending}
          options={ORG_ROLES.filter(
            (option): option is AssignableOrgRole =>
              option !== "owner" && (!!invitation || allowGuest || option !== "guest"),
          )}
          value={role}
          onValueChange={(value) => {
            form.setValue("role", value as AssignableOrgRole);
            form.clearErrors("root");
            if (form.formState.isSubmitted) void form.trigger("assignments");
          }}
        />
      </FieldGroup>
      <Controller
        control={form.control}
        name="assignments"
        rules={{
          validate: (value) => {
            if (form.getValues("role") === "admin") return true;
            if (value.length && (catalog.loading || catalog.error))
              return t("orgSettings.assignmentsNotReady");
            if (hasUnavailableAssignments(value, catalog.spaces, catalog.roleOptions))
              return t("orgSettings.assignmentsUnavailable");
            // No role requires a grant: a guest with none lands in their own
            // personal space, which is where a shared package is accepted.
            return true;
          },
        }}
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-2">
            <SpaceAssignmentsField
              spaces={catalog.spaces}
              roleOptions={catalog.roleOptions}
              loading={catalog.loading}
              error={catalog.error}
              onRetry={catalog.retry}
              value={field.value}
              onChange={(value) => {
                field.onChange(value);
                if (fieldState.error || form.formState.isSubmitted)
                  void form.trigger("assignments");
              }}
              disabled={isPending || role === "admin"}
              allSpacesAccess={role === "admin"}
              hint={t(
                role === "admin"
                  ? "orgSettings.roleHint.admin"
                  : role === "guest"
                    ? "orgSettings.inviteGuestSpacesHint"
                    : "orgSettings.inviteMemberSpacesHint",
              )}
            />
            {role !== "admin" && fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </div>
        )}
      />
      <FieldError>{form.formState.errors.root?.message}</FieldError>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            {t("common:btn.cancel")}
          </Button>
        )}
        <Button
          type="submit"
          disabled={isPending}
          className={invitation || onCancel ? "" : "sm:mr-auto"}
        >
          {isPending && <Spinner />}
          {t(invitation ? "common:btn.save" : "onboarding.invite")}
        </Button>
      </div>
    </form>
  );
}
