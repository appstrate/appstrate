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
 * The exposure and origin columns are the server's reading of the SAVED
 * package (empty while the package is being created); the scopes follow the
 * draft, so an applied change shows at once.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type {
  IntegrationToolInspection,
  IntegrationToolInspectionEntry,
} from "@appstrate/core/integration";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Switch } from "@appstrate/ui/components/switch";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Modal } from "../modal";
import { SettingRow, SettingsGroup } from "../settings/setting-row";
import { PageActionsMenu } from "../page-actions-menu";
import { PackageToolCatalog } from "../package-detail/package-tool-catalog";
import { TableRowActions } from "../table-row-actions";
import { RequiredScopesField } from "./required-scopes-field";
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

export function IntegrationToolsSection({
  inspection,
  integrationId,
  allowUndeclaredTools,
  edit,
  sync,
  showBasis = true,
}: {
  inspection: IntegrationToolInspection;
  /** The integration whose tools these are: it names a tool's inspection in the URL. */
  integrationId?: string;
  /** Read-only: whether the saved package lets agents call undeclared tools. */
  allowUndeclaredTools?: boolean;
  /** Off under the Outils heading, whose description says where the list comes from. */
  showBasis?: boolean;
  /** The draft manifest, when the reader may change the package. */
  edit?: { manifest: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void };
  /** Offered only when the integration can be asked for its tools (remote, connected). */
  sync?: {
    run: (connectionId?: string) => void;
    isPending: boolean;
    error: unknown;
    result: ServerSyncResult | null;
  };
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  // The tool being edited, or "new" for a tool added by name.
  const [policyTarget, setPolicyTarget] = useState<string | null>(null);
  const saved = inspection.entries;
  const policies = edit ? getToolsPolicy(edit.manifest) : null;

  // The saved catalog, its scopes replaced by the draft's, then the tools the
  // draft declares a policy for that the saved catalog does not list yet.
  const entries: IntegrationToolInspectionEntry[] = policies
    ? [
        ...saved.map((entry) => {
          const policy = policies.find((candidate) => candidate.name === entry.name);
          const { policy: _saved, ...rest } = entry;
          return policy ? { ...rest, policy: { required_scopes: policy.requiredScopes } } : rest;
        }),
        ...policies
          .filter((policy) => !saved.some((entry) => entry.name === policy.name))
          .map((policy) => ({
            name: policy.name,
            origin: "manifest" as const,
            exposure:
              inspection.basis === "manifest"
                ? ("available" as const)
                : ("not_in_catalog" as const),
            policy: { required_scopes: policy.requiredScopes },
          })),
      ]
    : saved;

  const allowUndeclared = edit ? getAllowUndeclaredTools(edit.manifest) : allowUndeclaredTools;
  const commit = (next: ToolPolicyState[]) => edit?.onChange(setToolsPolicy(edit.manifest, next));

  return (
    <div className="flex flex-col gap-4">
      {edit && sync && <SyncFromServer {...sync} />}
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
          tools={[]}
          inspection={{ basis: inspection.basis, entries }}
          integrationId={integrationId}
          showBasis={showBasis}
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
