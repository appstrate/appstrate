// SPDX-License-Identifier: Apache-2.0

/**
 * Package AFPS › Outils: an integration's tools and the policy each one
 * carries, as one table.
 *
 * Both come from the package alone: the local server's declared `tools[]`
 * (or the manifest's `tools_policy` keys) for the catalog, the manifest's
 * `tools_policy` for the scopes a tool requires. Nothing about them is set
 * per organization or per space, and which tools an agent may call is chosen
 * in the agent. So they are one section of the package: the catalog as a
 * table, the policy edited from each row, in a modal.
 *
 * The catalog is the server's reading of the SAVED package (empty while the
 * package is being created); the scopes follow the draft, so an applied change
 * shows at once.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { IntegrationToolCatalogEntry } from "@appstrate/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client";
import { invalidateIntegrationQueries } from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import { errorMessage } from "../../lib/mutation-error";
import { countToolsWithoutScopes } from "../../lib/integration-tool-scopes";
import type { ToolSnapshotInfo } from "../../lib/integration-tool-snapshot";
import { SyncConnectionChoice } from "./sync-connection-choice";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Switch } from "@appstrate/ui/components/switch";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Modal } from "../modal";
import { SettingRow, SettingsGroup } from "../settings/setting-row";
import { PageActionsMenu } from "../page-actions-menu";
import { PackageToolCatalog, type PackageTool } from "../package-detail/package-tool-catalog";
import { TableRowActions } from "../table-row-actions";
import { RequiredScopesField } from "./required-scopes-field";
import type { ServerSyncBlock } from "../../lib/integration-server-sync";
import { SyncFromServer, type ServerSyncResult } from "./sync-from-server";
import {
  getAllowUndeclaredTools,
  getAuths,
  isWildcardUsable,
  getToolsPolicy,
  setAllowUndeclaredTools,
  setToolsPolicy,
  type ToolPolicyState,
} from "./utils";

/** What the catalog's tools carry beyond the manifest's entry: the space's verdict on each. */
type CatalogTool = IntegrationToolCatalogEntry &
  Partial<Pick<PackageTool, "status" | "origin" | "modified">>;

export function IntegrationToolsSection({
  tools,
  allowUndeclaredTools,
  snapshot,
  edit,
  sync,
}: {
  /** The saved package's effective tool catalog (`tool_catalog`). */
  tools: CatalogTool[];
  /** The server's last listing. */
  snapshot?: ToolSnapshotInfo;
  /** Read-only: whether the saved package lets agents call undeclared tools. */
  allowUndeclaredTools?: boolean;
  /** The draft manifest, when the reader may change the package. */
  edit?: { manifest: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void };
  /** Offered for a remote integration; `blockedBy` disables it with the reason. */
  sync?: {
    run: (connectionId?: string) => void;
    isPending: boolean;
    error: unknown;
    result: ServerSyncResult | null;
    blockedBy: ServerSyncBlock | null;
  };
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  // The tool being edited, or "new" for a tool added by name.
  const [policyTarget, setPolicyTarget] = useState<string | null>(null);
  const policies = edit ? getToolsPolicy(edit.manifest) : null;

  // The saved catalog, its scopes replaced by the draft's, then the tools the
  // draft declares a policy for that the saved catalog does not list yet.
  const entries: PackageTool[] = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      permissions: policies
        ? policies.find((policy) => policy.name === tool.name)?.requiredScopes
        : tool.policy?.required_scopes,
      status: tool.status,
      origin: tool.origin,
      modified: tool.modified,
    })),
    ...(policies ?? [])
      .filter((policy) => !tools.some((tool) => tool.name === policy.name))
      .map((policy) => ({ name: policy.name, permissions: policy.requiredScopes })),
  ];

  const allowUndeclared = edit ? getAllowUndeclaredTools(edit.manifest) : allowUndeclaredTools;
  const commit = (next: ToolPolicyState[]) => edit?.onChange(setToolsPolicy(edit.manifest, next));

  return (
    <div className="flex flex-col gap-4">
      {edit && sync && <SyncFromServer {...sync} />}
      {snapshot && <ToolSnapshotSummary snapshot={snapshot} tools={entries} />}
      {edit ? (
        <AllowUndeclaredToggle manifest={edit.manifest} onChange={edit.onChange} />
      ) : (
        allowUndeclared && (
          <Alert variant="warning" size="sm">
            <AlertTitle>
              {t("integration.tools.wildcardNotice.title", { ns: "settings" })}
            </AlertTitle>
            <AlertDescription>
              {t("integration.tools.wildcardNotice.body", { ns: "settings" })}
            </AlertDescription>
          </Alert>
        )
      )}
      <div>
        <PackageToolCatalog
          tools={entries}
          listedAt={snapshot?.summary?.listed_at}
          actions={
            edit && (
              <PageActionsMenu
                actions={[
                  {
                    id: "add-tool",
                    label: t("integrationEditor.toolsPolicy.addTool"),
                    icon: Plus,
                    onSelect: () => setPolicyTarget("new"),
                  },
                ]}
              />
            )
          }
          rowActions={
            policies
              ? (tool) => (
                  <TableRowActions
                    menuLabel={t("editor.rowActions", { name: tool.name })}
                    actions={[
                      {
                        id: "edit",
                        label: t("integrationEditor.toolsPolicy.editScopes"),
                        icon: Pencil,
                        onSelect: () => setPolicyTarget(tool.name),
                      },
                      {
                        id: "remove",
                        label: t("integrationEditor.toolsPolicy.remove"),
                        icon: Trash2,
                        onSelect: () =>
                          commit(policies.filter((policy) => policy.name !== tool.name)),
                        hidden: !policies.some((policy) => policy.name === tool.name),
                      },
                    ]}
                  />
                )
              : undefined
          }
        />
      </div>

      {edit && policies && policyTarget !== null && (
        <Modal
          onClose={() => setPolicyTarget(null)}
          title={
            policyTarget === "new"
              ? t("integrationEditor.toolsPolicy.addTool")
              : t("integrationEditor.toolsPolicy.editTitle", { name: policyTarget })
          }
        >
          <ToolPolicyForm
            authKeys={getAuths(edit.manifest).map((auth) => auth.key)}
            initial={
              policies.find((policy) => policy.name === policyTarget) ?? {
                name: policyTarget === "new" ? "" : policyTarget,
                requiredScopes: {},
              }
            }
            isNew={policyTarget === "new"}
            takenNames={entries.map((entry) => entry.name)}
            onApply={(policy) => {
              const others = policies.filter((candidate) => candidate.name !== policy.name);
              commit([...others, policy]);
              setPolicyTarget(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/**
 * The last listing of the server (when, with which connection, what moved), the tools without a
 * declared permission, and the button that lists again. `tools` is what the table shows: in the
 * editor, the draft's policy.
 */
function ToolSnapshotSummary({
  snapshot,
  tools,
}: {
  snapshot: ToolSnapshotInfo;
  tools: PackageTool[];
}) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  const qc = useQueryClient();
  const refresh = $api.useMutation("post", "/api/integrations/{packageId}/tool-snapshot/refresh", {
    // The refusal is shown under the button, with the connection choice it may offer.
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateIntegrationQueries(qc),
  });
  const run = (connectionId?: string) =>
    refresh.mutate({
      params: { path: { packageId: snapshot.packageId } },
      body: connectionId ? { connection_id: connectionId } : {},
    });
  const withoutScopes = snapshot.oauth
    ? countToolsWithoutScopes(
        tools.map((tool) => ({
          status: tool.status,
          policy: { required_scopes: tool.permissions },
        })),
      )
    : 0;
  const { summary } = snapshot;
  return (
    <div className="flex flex-col gap-2" data-testid="integration-tool-snapshot">
      <p className="text-muted-foreground text-sm">
        {summary
          ? t("integrationTools.snapshot.summary", {
              date: formatDateField(summary.listed_at),
              added: summary.added,
              missing: summary.missing,
              modified: summary.modified,
            })
          : t("integrationTools.snapshot.never")}
      </p>
      {snapshot.connectionLabel && (
        <p className="text-muted-foreground text-sm">
          {t("integrationTools.snapshot.connection", { label: snapshot.connectionLabel })}
        </p>
      )}
      {summary?.truncated && (
        <p className="text-warning text-sm" data-testid="integration-tool-snapshot-truncated">
          {t("integrationTools.snapshot.truncated")}
        </p>
      )}
      {withoutScopes > 0 && (
        <p className="text-warning text-sm">
          {t("integrationTools.withoutScopes", { count: withoutScopes })}
        </p>
      )}
      {snapshot.remote && can("credential-proxy:call-own") && (
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => run()}
            data-testid="integration-tool-snapshot-refresh"
          >
            {refresh.isPending ? <Spinner /> : <RefreshCw />}
            {t("integrationTools.snapshot.refresh")}
          </Button>
          {refresh.error != null && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(refresh.error)}
            </p>
          )}
          <SyncConnectionChoice error={refresh.error} onChoose={run} disabled={refresh.isPending} />
        </div>
      )}
    </div>
  );
}

function ToolPolicyForm({
  authKeys,
  initial,
  isNew,
  takenNames,
  onApply,
}: {
  authKeys: string[];
  initial: ToolPolicyState;
  isNew: boolean;
  takenNames: string[];
  onApply: (policy: ToolPolicyState) => void;
}) {
  const { t } = useTranslation("agents");
  const [policy, setPolicy] = useState(initial);
  const name = policy.name.trim();
  const nameError = !isNew
    ? null
    : !name
      ? t("integrationEditor.toolsPolicy.nameRequired")
      : takenNames.includes(name)
        ? t("integrationEditor.toolsPolicy.nameTaken")
        : null;
  return (
    <div className="flex flex-col gap-5">
      {isNew && (
        <FormItem
          id="tool-policy-name"
          label={t("integrationEditor.toolsPolicy.toolName")}
          error={policy.name ? nameError : undefined}
        >
          <Input
            value={policy.name}
            onChange={(event) => setPolicy((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="list_issues"
            className="font-mono"
          />
        </FormItem>
      )}
      <RequiredScopesField
        authKeys={authKeys}
        value={policy.requiredScopes}
        onChange={(requiredScopes) => setPolicy((prev) => ({ ...prev, requiredScopes }))}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={nameError !== null}
          onClick={() => onApply({ ...policy, name })}
        >
          {t("editor.apply")}
        </Button>
      </div>
    </div>
  );
}

/** AFPS §7.8: the wildcard needs an auth that can grant any tool wholesale. */
function AllowUndeclaredToggle({
  manifest,
  onChange,
}: {
  manifest: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation("agents");
  const allowUndeclared = getAllowUndeclaredTools(manifest);
  const usable = isWildcardUsable(getAuths(manifest));
  // The grammar of every activation setting (collaborator SSO, for one): a
  // toggle row, its consequence as the description.
  return (
    <SettingsGroup className="mb-4">
      <SettingRow
        variant="toggle"
        className="pb-0"
        label={
          <Label htmlFor="allow-undeclared-tools" className="cursor-pointer">
            {t("integrationEditor.allowUndeclaredTools.label")}
          </Label>
        }
        description={
          <>
            {t("integrationEditor.allowUndeclaredTools.summary")}
            {/* Why the toggle is off stays in view: it is what the reader acts on. */}
            {!usable && (
              <span className="text-destructive mt-1 block">
                {t("integrationEditor.allowUndeclaredTools.requiresWildcardUsableAuth")}
              </span>
            )}
          </>
        }
        details={t("integrationEditor.allowUndeclaredTools.description")}
      >
        <Switch
          id="allow-undeclared-tools"
          data-testid="integration-editor-allow-undeclared-tools"
          checked={allowUndeclared}
          disabled={!usable && !allowUndeclared}
          onCheckedChange={(checked) => onChange(setAllowUndeclaredTools(manifest, checked))}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
