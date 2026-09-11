// SPDX-License-Identifier: Apache-2.0

/**
 * What each organisation role can do, side by side.
 *
 * The four org roles are code, the same in every organisation, so the grid is
 * static. It MIRRORS `ORG_ROLE_PERMISSIONS` in `apps/api/src/lib/permissions.ts`,
 * which the browser bundle cannot import: a change to a role's set there has
 * to be written here too. Rows are capabilities a person recognises rather
 * than permission strings; the space roles, the other half of any answer about
 * "what can they do in there", are one link away.
 */
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { OrgRole } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { roleI18nKey } from "../hooks/use-permissions";
import { MATRIX_HEAD } from "../lib/matrix-head";
import { Modal } from "./modal";
import { PermissionMark } from "./permission-mark";

const ROLES: readonly OrgRole[] = ["owner", "admin", "member", "guest"];

/** Capability → the org roles holding it, with the permissions it stands for. */
const CAPABILITIES: readonly { key: string; roles: readonly OrgRole[] }[] = [
  // org:read, spaces:read, models:read, proxies:read
  { key: "view", roles: ["owner", "admin", "member", "guest"] },
  // members:read — a guest does not enumerate the directory
  { key: "directory", roles: ["owner", "admin", "member"] },
  // members:invite, members:remove, members:change-role
  { key: "manageMembers", roles: ["owner", "admin"] },
  // roles:write, roles:delete
  { key: "customRoles", roles: ["owner", "admin"] },
  // spaces:write, spaces:delete
  { key: "spaces", roles: ["owner", "admin"] },
  // models:*, model-provider-credentials:*, proxies:*
  { key: "infrastructure", roles: ["owner", "admin"] },
  // org:settings
  { key: "settings", roles: ["owner", "admin"] },
  // org:update, org:delete — the org's identity is owner-only
  { key: "identity", roles: ["owner"] },
];

/** How far each org role reaches into spaces (`resolveSpaceRole`). */
const SPACE_ACCESS: Record<OrgRole, "all" | "open" | "assigned"> = {
  owner: "all",
  admin: "all",
  member: "open",
  guest: "assigned",
};

export function OrgRolesGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("orgRolesGuide.title")}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
      actions={
        <Button type="button" variant="outline" onClick={onClose}>
          {t("btn.close", { ns: "common" })}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <p className="text-muted-foreground text-sm">{t("orgRolesGuide.intro")}</p>
        <div className="overflow-hidden rounded-lg border">
          <Table className="w-full" style={{ minWidth: 224 + ROLES.length * 96 }}>
            <TableHeader>
              <TableRow>
                <TableHead className={MATRIX_HEAD}>
                  <span className="sr-only">{t("orgRolesGuide.capability")}</span>
                </TableHead>
                {ROLES.map((role) => (
                  <TableHead
                    key={role}
                    className={`${MATRIX_HEAD} w-24 text-center leading-tight whitespace-normal`}
                  >
                    {t(roleI18nKey(role))}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {CAPABILITIES.map((capability) => (
                <TableRow key={capability.key}>
                  <TableCell className="text-sm whitespace-normal">
                    {t(`orgRolesGuide.can.${capability.key}`)}
                  </TableCell>
                  {ROLES.map((role) => (
                    <TableCell key={role} className="text-center">
                      <PermissionMark granted={capability.roles.includes(role)} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="text-sm font-medium">
                  {t("orgRolesGuide.spaceAccess")}
                </TableCell>
                {ROLES.map((role) => (
                  <TableCell
                    key={role}
                    className="text-muted-foreground max-w-32 text-center text-xs whitespace-normal"
                  >
                    {t(`orgRolesGuide.access.${SPACE_ACCESS[role]}`)}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("orgRolesGuide.spaceRolesHint")}{" "}
          <Link
            to="/org-settings/roles"
            state={location.state}
            className="text-primary underline underline-offset-4"
          >
            {t("orgRolesGuide.spaceRolesLink")}
          </Link>
        </p>
      </div>
    </Modal>
  );
}
