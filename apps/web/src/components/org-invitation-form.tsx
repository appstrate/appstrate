// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { useSpaces } from "../hooks/use-spaces";
import { spaceRoleValue, useSpaceRoleOptions } from "../hooks/use-roles";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { ASSIGNABLE_ORG_ROLES, type AssignableOrgRole } from "@appstrate/shared-types";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { Field, FieldDescription, FieldGroup } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { $api, type components } from "../api/client";
import { roleI18nKey } from "../hooks/use-permissions";
import {
  hasUnavailableAssignments,
  assignmentsFor,
  toSpaceAssignments,
  validateSpaceAssignments,
  type AssignmentDraft,
} from "../lib/space-assignments";
import { SpaceAssignmentsField } from "./space-assignments-field";
import { Spinner } from "./spinner";

interface InviteFormValues {
  email: string;
  role: AssignableOrgRole;
  assignments: AssignmentDraft[];
}

/** The same invitation flow in onboarding and organization settings. Remount on org change. */
export function OrgInvitationForm({
  orgId,
  invitation,
  onSuccess,
  onCancel,
}: {
  orgId: string;
  invitation?: components["schemas"]["OrgInvitationInfo"];
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const spacesQuery = useSpaces();
  const rolesQuery = useSpaceRoleOptions();
  const spaces = spacesQuery.data ?? [];
  const catalogLoading = spacesQuery.isLoading || rolesQuery.isLoading;
  const catalogError = spacesQuery.error || rolesQuery.error;
  const form = useForm<InviteFormValues>({
    defaultValues: {
      email: invitation?.email ?? "",
      // Invitations cannot grant ownership; the API enforces AssignableOrgRole.
      role: (invitation?.role ?? "member") as AssignableOrgRole,
      assignments: (invitation?.space_assignments ?? []).map((assignment) => ({
        space_id: assignment.space_id,
        role: spaceRoleValue(assignment),
      })),
    },
  });
  const role = useWatch({ control: form.control, name: "role" });
  const complete = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}"] });
    form.reset();
    onSuccess?.();
  };
  const onError = (error: unknown) => form.setError("root", { message: getErrorMessage(error) });
  const invite = $api.useMutation("post", "/api/orgs/{orgId}/members", {
    onSuccess: (_result, request) => {
      toast.success(t("orgSettings.inviteSuccess", { email: request.body.email }));
      complete();
    },
    onError,
  });

  const update = $api.useMutation("put", "/api/orgs/{orgId}/invitations/{invitationId}", {
    onSuccess: () => {
      toast.success(t("orgSettings.inviteUpdated"));
      complete();
    },
    onError,
  });
  const isPending = invite.isPending || update.isPending;
  const fieldPrefix = invitation ? "edit-invite" : "invite";

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((data) => {
        const body = {
          role: data.role,
          space_assignments: assignmentsFor(data.role, toSpaceAssignments(data.assignments)),
        };
        if (invitation) {
          update.mutate({ params: { path: { orgId, invitationId: invitation.id } }, body });
        } else {
          invite.mutate({
            params: { path: { orgId } },
            body: { ...body, email: data.email.trim() },
          });
        }
      })}
      className="flex flex-col gap-4"
    >
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={!!form.formState.errors.email}>
          <Label htmlFor={`${fieldPrefix}-email`}>{t("orgSettings.inviteEmailAriaLabel")}</Label>
          <Input
            id={`${fieldPrefix}-email`}
            type="email"
            readOnly={!!invitation}
            autoComplete="email"
            placeholder="email@example.com"
            disabled={isPending}
            aria-invalid={!!form.formState.errors.email}
            aria-describedby={
              form.formState.errors.email ? `${fieldPrefix}-email-error` : undefined
            }
            {...form.register("email", {
              required: t("common:validation.required"),
              setValueAs: (value: string) => value.trim(),
              validate: (value) =>
                z.email().safeParse(value).success || t("common:validation.emailFormat"),
            })}
          />
          {form.formState.errors.email && (
            <p id={`${fieldPrefix}-email-error`} role="alert" className="text-destructive text-sm">
              {form.formState.errors.email.message}
            </p>
          )}
        </Field>
        <Field>
          <Label htmlFor={`${fieldPrefix}-role`}>{t("orgSettings.inviteRoleAriaLabel")}</Label>
          <Select
            value={role}
            disabled={isPending}
            onValueChange={(value) => {
              form.setValue("role", value as AssignableOrgRole);
              form.clearErrors("root");
              if (form.formState.isSubmitted) void form.trigger("assignments");
            }}
          >
            <SelectTrigger
              id={`${fieldPrefix}-role`}
              className="w-full"
              aria-describedby={`${fieldPrefix}-role-hint`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ASSIGNABLE_ORG_ROLES.filter((option) => !!invitation || option !== "guest").map(
                  (option) => (
                    <SelectItem key={option} value={option}>
                      {t(roleI18nKey(option))}
                    </SelectItem>
                  ),
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription id={`${fieldPrefix}-role-hint`}>
            {t(`orgSettings.roleHint.${role}`)}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <Controller
        control={form.control}
        name="assignments"
        rules={{
          validate: (value) => {
            if (form.getValues("role") === "admin") return true;
            if (value.length && (catalogLoading || catalogError))
              return t("orgSettings.assignmentsNotReady");
            if (hasUnavailableAssignments(value, spaces, rolesQuery.options))
              return t("orgSettings.assignmentsUnavailable");
            return validateSpaceAssignments(
              form.getValues("role"),
              toSpaceAssignments(value),
              t("orgSettings.inviteSpacesRequired"),
            );
          },
        }}
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-2">
            <SpaceAssignmentsField
              spaces={spaces}
              roleOptions={rolesQuery.options}
              loading={catalogLoading}
              error={catalogError}
              onRetry={() => {
                void spacesQuery.refetch();
                void rolesQuery.refetch();
              }}
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
              <p role="alert" className="text-destructive text-sm">
                {fieldState.error.message}
              </p>
            )}
          </div>
        )}
      />
      {form.formState.errors.root && (
        <p role="alert" className="text-destructive text-sm">
          {form.formState.errors.root.message}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            {t("common:btn.cancel")}
          </Button>
        )}
        <Button type="submit" disabled={isPending} className={invitation ? "" : "sm:mr-auto"}>
          {isPending && <Spinner />}
          {t(invitation ? "common:btn.save" : "onboarding.invite")}
        </Button>
      </div>
    </form>
  );
}
