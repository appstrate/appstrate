// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Input } from "@appstrate/ui/components/input";
import { Button } from "@appstrate/ui/components/button";
import { getErrorMessage } from "@appstrate/core/errors";
import { Spinner } from "./spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { DEFAULT_SPACE_ROLE_VALUE, type SpaceRoleOption } from "../hooks/use-roles";
import type { AssignmentDraft } from "../lib/space-assignments";

/**
 * Space assignments shared by invitations and OAuth signup.
 *
 * `guest` has no implicit access anywhere, so the API refuses an empty list for
 * it (400) and refuses a non-empty one for `admin`, who already runs every
 * space — this field mirrors both rules rather than letting the user find out
 * on submit.
 */
export function SpaceAssignmentsField({
  value,
  onChange,
  disabled,
  hint,
  spaces,
  roleOptions,
  loading,
  error,
  onRetry,
  allSpacesAccess = false,
}: {
  value: AssignmentDraft[];
  onChange: (next: AssignmentDraft[]) => void;
  disabled: boolean;
  hint: string;
  spaces: { id: string; name: string }[];
  roleOptions: SpaceRoleOption[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  allSpacesAccess?: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const unavailable = disabled || loading || !!error;
  const taken = new Set(value.map((a) => a.space_id));
  const available = spaces.filter((s) => !taken.has(s.id));
  const defaultRole = DEFAULT_SPACE_ROLE_VALUE;

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{t("orgSettings.inviteSpacesLabel")}</legend>
      <p className="text-muted-foreground text-sm">{hint}</p>
      {allSpacesAccess ? (
        <Input
          disabled
          value={t("orgSettings.allSpacesAccess")}
          aria-label={t("orgSettings.inviteSpacesLabel")}
        />
      ) : (
        <>
          {loading && (
            <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner />
              {t("orgSettings.assignmentsLoading")}
            </p>
          )}
          {!!error && (
            <div
              role="alert"
              className="text-destructive flex flex-wrap items-center gap-2 text-sm"
            >
              <span>{getErrorMessage(error)}</span>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t("common:btn.retry")}
              </Button>
            </div>
          )}
          {!loading && !error && spaces.length === 0 && (
            <p className="text-muted-foreground text-sm">{t("orgSettings.assignmentsNoSpaces")}</p>
          )}
          {value.map((assignment, index) => {
            const space = spaces.find((s) => s.id === assignment.space_id);
            return (
              <div
                key={assignment.space_id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <span className="col-span-2 text-sm font-medium break-words sm:col-span-1">
                  {space?.name ?? t("orgSettings.assignmentUnavailableSpace")}
                </span>
                <Select
                  value={assignment.role}
                  disabled={unavailable}
                  onValueChange={(role) =>
                    onChange(value.map((a, i) => (i === index ? { ...a, role } : a)))
                  }
                >
                  <SelectTrigger
                    className="w-full min-w-0"
                    aria-label={t("orgSettings.inviteSpaceRoleAriaLabel", {
                      space: space?.name ?? t("orgSettings.assignmentUnavailableSpace"),
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {!roleOptions.some((option) => option.value === assignment.role) && (
                        <SelectItem value={assignment.role} disabled>
                          {t("orgSettings.assignmentUnavailableRole")}
                        </SelectItem>
                      )}
                      {roleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={t("orgSettings.inviteSpaceRemove")}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X size={16} />
                </Button>
              </div>
            );
          })}
          {!loading && !error && available.length > 0 && (
            <Select
              value=""
              disabled={unavailable}
              onValueChange={(spaceId) =>
                onChange([...value, { space_id: spaceId, role: defaultRole }])
              }
            >
              <SelectTrigger className="w-full" aria-label={t("orgSettings.inviteSpaceAdd")}>
                <SelectValue placeholder={t("orgSettings.inviteSpaceAdd")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {available.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </>
      )}
    </fieldset>
  );
}
