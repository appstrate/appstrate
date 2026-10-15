// SPDX-License-Identifier: Apache-2.0

/**
 * Every real column set keeps its promise to the reader: a column that holds a
 * control, and the row's « … », are never given a tier to hide at.
 */

import { describe, it, expect } from "bun:test";
import type { ReactElement } from "react";
import type { IntegrationManifestView } from "../../hooks/use-integrations.ts";
import type { DataColumn } from "../data-table.tsx";
import { useRunColumns } from "../run-columns.tsx";
import { useScheduleColumns } from "../schedule-columns.tsx";
import { usePackageColumns } from "../package-columns.tsx";
import { useProxyColumns } from "../../pages/org-settings/proxy-columns.tsx";
import {
  useConnectionColumns,
  useIntegrationClientColumns,
} from "../integration-detail/integration-columns.tsx";
import { useMemberColumns } from "../../pages/org-settings/member-columns.tsx";
import { useRoleColumns } from "../../pages/org-settings/role-columns.tsx";
import { useSpaceMemberColumns } from "../../pages/workspace-settings/space-member-columns.tsx";
import { useInvitationColumns } from "../invitation-columns.tsx";
import {
  useCatalogueActionsColumn,
  useCatalogueOriginColumn,
  useCatalogueSelectColumn,
  useCatalogueSpaceColumns,
} from "../catalogue-columns.tsx";
import { useUserSpaceColumns } from "../../pages/org-settings/user-space-columns.tsx";
import { useSpaceColumns } from "../../pages/org-settings/space-columns.tsx";
import { useProviderColumns } from "../provider-columns.tsx";
import { usePersonalServiceColumns } from "../personal-service-columns.tsx";
import { useOAuthClientColumns } from "../../modules/oidc/components/oauth-client-columns.tsx";
import { useCliSessionColumns } from "../cli-session-columns.tsx";
import { useEndUserColumns } from "../../pages/end-user-columns.tsx";
import { useWebhookColumns } from "../../modules/webhooks/components/webhook-columns.tsx";
import { useDocumentColumns } from "../document-columns.tsx";
import { useIntegrationListColumns } from "../../pages/integration-list-columns.tsx";
import { useApiKeyColumns } from "../../pages/api-key-columns.tsx";
import { useMemoryColumns } from "../persistence/memory-columns.tsx";
import { useCatalogueSharedColumns } from "../catalogue-shared-columns.tsx";
import { usePinColumns } from "../integration-detail/pin-columns.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

type Track = Pick<DataColumn<never>, "tier" | "control"> & { header?: string };

/** Runs the hook the way a screen does, and hands back what it returned. */
function columnsFrom<T>(useColumns: () => DataColumn<T>[]): Track[] {
  let captured: Track[] = [];
  function Probe(): ReactElement | null {
    captured = useColumns();
    return null;
  }
  render(<Probe />);
  return captured;
}

const SETS = {
  // Composed exactly as `OrgCatalogueModal` composes it: the tick, the list's
  // own set minus what a catalogue cannot answer, then provenance, one column
  // per space, and the one deed.
  packageCatalogue: () => {
    return columnsFrom(() => [
      useCatalogueSelectColumn({
        selected: new Set<string>(),
        allSelected: false,
        selectable: () => true,
        onToggle: () => {},
        onToggleAll: () => {},
      }),
      ...usePackageColumns("agent").filter(
        (c) => !["state", "actions", "origin", "keywords"].includes(c.id),
      ),
      // The organization view, the wider of the two: provenance, then one
      // column per space the caller reaches — three here, which is what the
      // arithmetic below has to hold.
      useCatalogueOriginColumn("Globex"),
      ...useCatalogueSpaceColumns({
        spaces: [
          { id: "spc_a", name: "Default" },
          { id: "spc_b", name: "Production" },
          { id: "spc_c", name: "Bac à sable" },
        ],
        // The space the app stands in carries an "ici" pill beside its name:
        // the widest head this column set can draw.
        currentSpaceId: "spc_a",
        placementOf: () => undefined,
        gateOf: () => ({ allowed: true, refusal: null }),
        busy: false,
        onSetActive: () => {},
      }),
      useCatalogueActionsColumn({
        isPending: false,
        deedsOf: () => ({ moveHome: true, share: true, revokeFrom: [] }),
        spaceNameOf: (id) => id,
        onOpen: () => {},
        onMoveHome: () => {},
        onShare: () => {},
        onRevoke: () => {},
      }),
    ]);
  },
  userSpaces: () =>
    columnsFrom(() =>
      useUserSpaceColumns({
        member: { userId: "usr_x", role: "member" },
        editable: () => true,
        roles: [],
        roleOptions: [],
        isChangingRole: false,
        onChangeRole: () => {},
      }),
    ),
  roles: () =>
    columnsFrom(() =>
      useRoleColumns({ canDelete: () => true, isDeleting: false, onDelete: () => {} }),
    ),
  spaceMembers: () =>
    columnsFrom(() =>
      useSpaceMemberColumns({
        editable: () => true,
        roles: [],
        roleOptions: [],
        isChangingRole: false,
        onChangeRole: () => {},
        removal: () => "remove",
        isRemoving: false,
        removeDisabled: false,
        onRemove: () => {},
      }),
    ),
  invitations: () =>
    columnsFrom(() =>
      useInvitationColumns({
        assignments: () => [],
        canEdit: true,
        isCanceling: false,
        onEdit: () => {},
        onCopyLink: () => {},
        onCancel: () => {},
      }),
    ),
  runs: () => columnsFrom(() => useRunColumns({ agentName: () => "Compta trimestrielle" })),
  schedules: () => columnsFrom(() => useScheduleColumns({ agentName: () => "Wiki-brain" })),
  packages: () => columnsFrom(() => usePackageColumns("agent")),
  // The organization's providers table, no Type column.
  providers: () =>
    columnsFrom(() =>
      useProviderColumns({
        registry: undefined,
        testingIds: new Set(),
        testResults: {},
        renamingId: null,
        onRenamingChange: () => {},
        onTest: () => {},
        onRename: async () => {},
        onChooseModels: () => {},
        onChangeKey: () => {},
        onReconnect: () => {},
        onDelete: () => {},
        onSetDefault: () => {},
        canWriteModels: true,
      }),
    ),
  // Preferences: the caller's own providers, with the kind of each.
  myProviders: () =>
    columnsFrom(() =>
      useProviderColumns({
        registry: undefined,
        testingIds: new Set(),
        testResults: {},
        renamingId: null,
        onRenamingChange: () => {},
        onTest: () => {},
        onRename: async () => {},
        onChangeKey: () => {},
        onReconnect: () => {},
        onDelete: () => {},
        canWriteModels: false,
        showType: true,
      }),
    ),
  // The services open to personal keys (Settings › Models › Clés perso).
  personalServices: () =>
    columnsFrom(() =>
      usePersonalServiceColumns({ canWriteModels: true, onChooseModels: () => {} }),
    ),
  proxies: () =>
    columnsFrom(() =>
      useProxyColumns({
        testingIds: new Set(),
        testResults: {},
        settingDefaultId: null,
        onTest: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onSetDefault: () => {},
      }),
    ),
  integrationClients: () =>
    columnsFrom(() =>
      useIntegrationClientColumns({
        canUseHere: true,
        canManageOrg: true,
        canChooseOrgDefault: true,
        pendingClientRef: null,
        onUseHere: () => {},
        onUseForOrg: () => {},
        onEdit: () => {},
        onPromote: () => {},
        onDelete: () => {},
      }),
    ),
  members: () =>
    columnsFrom(() =>
      useMemberColumns({
        assignableRoles: () => ["admin", "member"],
        canRemove: () => true,
        isChangingRole: false,
        isRemoving: false,
        onChangeRole: () => {},
        onRemove: () => {},
        spaces: () => ["Production"],
      }),
    ),
  spaces: () => columnsFrom(() => useSpaceColumns({ defaultLabel: "Défaut" })),
  connections: () =>
    columnsFrom(() =>
      useConnectionColumns({
        packageId: "@appstrate/google-drive",
        manifest: {} as IntegrationManifestView,
        userId: "user_1",
        isAdmin: true,
        authForConnection: () => ({ authKey: "drive", authType: "oauth2", canRenew: true }),
        methodLabel: () => "OAuth",
      }),
    ),
  oauthClients: () =>
    columnsFrom(() =>
      useOAuthClientColumns({
        onEdit: () => {},
      }),
    ),
  cliSessions: () =>
    columnsFrom(() =>
      useCliSessionColumns({
        revokingFamilyId: null,
        onRevoke: () => {},
      }),
    ),
  endUsers: () =>
    columnsFrom(() =>
      useEndUserColumns({
        deletingUserId: null,
        onEdit: () => {},
        onDelete: () => {},
      }),
    ),
  webhooks: () => columnsFrom(() => useWebhookColumns()),
  documents: () =>
    columnsFrom(() =>
      useDocumentColumns({
        pendingKeepId: null,
        showRunLink: true,
        onDownload: () => {},
        onKeep: () => {},
        onDelete: () => {},
      }),
    ),
  integrations: () => columnsFrom(() => useIntegrationListColumns()),
  memory: () =>
    columnsFrom(() =>
      useMemoryColumns({ isDeleting: () => false, onCopy: () => {}, onDelete: () => {} }),
    ),
  catalogueShared: () =>
    columnsFrom(() =>
      useCatalogueSharedColumns({
        spaceNameOf: (id) => id,
        mayActivateIn: () => true,
        busy: false,
        onActivate: () => {},
      }),
    ),
  integrationPins: () =>
    columnsFrom(() =>
      usePinColumns({
        agentName: (pin) => pin.agent_package_id,
        pinnable: [],
        connections: [],
        isDeleting: () => false,
        onDelete: () => {},
      }),
    ),
  apiKeys: () =>
    columnsFrom(() =>
      useApiKeyColumns({
        availableScopes: ["agents:read", "agents:run", "runs:read"],
        revokingKeyId: null,
        onRevoke: () => {},
      }),
    ),
};

describe.each(Object.entries(SETS))("the %s column set", (_name, load) => {
  const columns = load();

  it("never gives a control, or the row's end, a tier to hide at", () => {
    for (const column of columns) {
      if (column.control) expect(column.tier).toBeUndefined();
      if (column.header === "") expect(column.tier).toBeUndefined();
    }
  });

  it("was actually read", () => {
    // A hook that threw would hand back an empty array and the check above would pass on nothing.
    expect(columns.length).toBeGreaterThan(2);
  });
});
