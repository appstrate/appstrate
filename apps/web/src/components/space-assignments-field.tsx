// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
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
  spaces,
  roleOptions,
  disabled,
  hint,
}: {
  value: AssignmentDraft[];
  onChange: (next: AssignmentDraft[]) => void;
  spaces: { id: string; name: string }[];
  roleOptions: SpaceRoleOption[];
  disabled: boolean;
  hint: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const taken = new Set(value.map((a) => a.space_id));
  const available = spaces.filter((s) => !taken.has(s.id));
  const defaultRole = DEFAULT_SPACE_ROLE_VALUE;

  return (
    <div className="space-y-2">
      <Label>{t("orgSettings.inviteSpacesLabel")}</Label>
      <p className="text-muted-foreground text-sm">{hint}</p>
      {value.map((assignment, index) => {
        const space = spaces.find((s) => s.id === assignment.space_id);
        return (
          <div key={assignment.space_id} className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm">{space?.name ?? assignment.space_id}</span>
            <Select
              value={assignment.role}
              disabled={disabled}
              onValueChange={(role) =>
                onChange(value.map((a, i) => (i === index ? { ...a, role } : a)))
              }
            >
              <SelectTrigger
                className="w-[160px]"
                aria-label={t("orgSettings.inviteSpaceRoleAriaLabel", {
                  space: space?.name ?? assignment.space_id,
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
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
      {available.length > 0 && (
        <Select
          value=""
          disabled={disabled}
          onValueChange={(spaceId) =>
            onChange([...value, { space_id: spaceId, role: defaultRole }])
          }
        >
          <SelectTrigger className="w-[220px]" aria-label={t("orgSettings.inviteSpaceAdd")}>
            <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Plus size={14} />
              {t("orgSettings.inviteSpaceAdd")}
            </span>
          </SelectTrigger>
          <SelectContent>
            {available.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
