// SPDX-License-Identifier: Apache-2.0

/**
 * Package AFPS › Outils: an integration's tools and the policy each one
 * carries, as one table.
 *
 * The catalog was an Explorer section and its policy a separate Définition
 * form, yet both come from the package alone: the local server's declared
 * `tools[]` (or the manifest's `tools_policy` keys) for the catalog, the
 * manifest's `tools_policy` for the scopes a tool requires. Nothing about
 * them is set per organisation or per space, and which tools an agent may
 * call is chosen in the agent. So they are one section of the package: the
 * catalog as a table, the policy edited from each row, in a modal.
 *
 * The exposure and origin columns are the server's reading of the SAVED
 * package; the scopes follow the draft, so an applied change shows at once.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type {
  IntegrationToolInspection,
  IntegrationToolInspectionEntry,
} from "@appstrate/core/integration";
import { Button } from "@appstrate/ui/components/button";
import { Switch } from "@appstrate/ui/components/switch";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { useModalParam } from "../../hooks/use-modal-param";
import { Modal } from "../modal";
import { SettingRow, SettingsGroup } from "../settings/setting-row";
import { PageActionsMenu } from "../page-actions-menu";
import { PackageToolCatalog } from "../package-detail/package-tool-catalog";
import { TableRowActions } from "../table-row-actions";
import { StringListInput } from "./string-list-input";
import {
  getAllowUndeclaredTools,
  getAuths,
  getToolsPolicy,
  setAllowUndeclaredTools,
  setToolsPolicy,
  type ToolPolicyState,
} from "./utils";

const NO_ENTRIES: IntegrationToolInspectionEntry[] = [];

export function IntegrationToolsSection({
  inspection,
  allowUndeclaredTools,
  edit,
}: {
  inspection?: IntegrationToolInspection;
  /** Read-only: whether the saved package lets agents call undeclared tools. */
  allowUndeclaredTools?: boolean;
  /** The draft manifest, when the reader may change the package. */
  edit?: { manifest: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void };
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const policyModal = useModalParam("toolPolicy");
  const saved = inspection?.entries ?? NO_ENTRIES;
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
              inspection?.basis === "manifest"
                ? ("available" as const)
                : ("not_in_catalog" as const),
            policy: { required_scopes: policy.requiredScopes },
          })),
      ]
    : saved;

  const allowUndeclared = edit ? getAllowUndeclaredTools(edit.manifest) : allowUndeclaredTools;
  const commit = (next: ToolPolicyState[]) => edit?.onChange(setToolsPolicy(edit.manifest, next));

  return (
    <div className="space-y-4">
      {edit ? (
        <AllowUndeclaredToggle manifest={edit.manifest} onChange={edit.onChange} />
      ) : (
        allowUndeclared && (
          <div className="rounded-md border-l-2 border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="font-medium">
              {t("integration.tools.wildcardNotice.title", { ns: "settings" })}
            </p>
            <p className="text-muted-foreground mt-1">
              {t("integration.tools.wildcardNotice.body", { ns: "settings" })}
            </p>
          </div>
        )
      )}
      <PackageToolCatalog
        tools={[]}
        inspection={{ basis: inspection?.basis ?? "manifest", entries }}
        actions={
          edit && (
            <PageActionsMenu>
              <DropdownMenuItem onSelect={() => policyModal.open("new")}>
                <Plus />
                {t("integrationEditor.toolsPolicy.addTool")}
              </DropdownMenuItem>
            </PageActionsMenu>
          )
        }
        rowActions={
          policies
            ? (tool) => (
                <TableRowActions menuLabel={t("editor.rowActions", { name: tool.name })}>
                  <DropdownMenuItem onSelect={() => policyModal.open(tool.name)}>
                    <Pencil />
                    {t("integrationEditor.toolsPolicy.editScopes")}
                  </DropdownMenuItem>
                  {policies.some((policy) => policy.name === tool.name) && (
                    <DropdownMenuItem
                      onSelect={() =>
                        commit(policies.filter((policy) => policy.name !== tool.name))
                      }
                    >
                      <Trash2 />
                      {t("integrationEditor.toolsPolicy.remove")}
                    </DropdownMenuItem>
                  )}
                </TableRowActions>
              )
            : undefined
        }
      />

      {edit && policies && policyModal.value !== null && (
        <Modal
          open
          onClose={policyModal.close}
          title={
            policyModal.value === "new"
              ? t("integrationEditor.toolsPolicy.addTool")
              : t("integrationEditor.toolsPolicy.editTitle", { name: policyModal.value })
          }
        >
          <ToolPolicyForm
            authKeys={getAuths(edit.manifest).map((auth) => auth.key)}
            initial={
              policies.find((policy) => policy.name === policyModal.value) ?? {
                name: policyModal.value === "new" ? "" : policyModal.value,
                requiredScopes: {},
              }
            }
            isNew={policyModal.value === "new"}
            takenNames={entries.map((entry) => entry.name)}
            onApply={(policy) => {
              const others = policies.filter((candidate) => candidate.name !== policy.name);
              commit([...others, policy]);
              policyModal.close();
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
    <div className="space-y-5">
      {isNew && (
        <div className="space-y-1.5">
          <Label htmlFor="tool-policy-name">{t("integrationEditor.toolsPolicy.toolName")}</Label>
          <Input
            id="tool-policy-name"
            value={policy.name}
            onChange={(event) => setPolicy((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="list_issues"
            className="font-mono"
          />
          {policy.name && nameError && <p className="text-destructive text-xs">{nameError}</p>}
        </div>
      )}
      <div className="space-y-2">
        <Label>{t("integrationEditor.toolsPolicy.requiredScopes")}</Label>
        <p className="text-muted-foreground text-xs">
          {t("integrationEditor.toolsPolicy.requiredScopesDesc")}
        </p>
        {authKeys.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            {t("integrationEditor.toolsPolicy.noAuths")}
          </p>
        ) : (
          authKeys.map((key) => (
            <StringListInput
              key={key}
              label={key}
              values={policy.requiredScopes[key] ?? []}
              onChange={(scopes) =>
                setPolicy((prev) => ({
                  ...prev,
                  requiredScopes: { ...prev.requiredScopes, [key]: scopes },
                }))
              }
              placeholder="read"
            />
          ))
        )}
      </div>
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
  const usable = getAuths(manifest).some(
    (auth) => auth.type !== "oauth2" || auth.defaultScopes.length > 0,
  );
  // The grammar of every activation setting (collaborator SSO, for one): a
  // toggle row, its consequence as the description.
  return (
    <SettingsGroup>
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
