// SPDX-License-Identifier: Apache-2.0

/**
 * The working space's verdict on a remote integration's tools: the undeclared tools the server
 * lists that wait for a review (approve or block), the definitions approved, the tools blocked.
 * What the agents may call follows from it (`tool_catalog` statuses); only a reader who may
 * configure the integration in the space sees it.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  useIntegrationToolPolicy,
  useIntegrationToolPolicyActions,
} from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import {
  approvalBody,
  blockBody,
  blockableTools,
  reviewItems,
  type ReviewItem,
  type ToolPolicy,
} from "../../lib/integration-tool-policy";
import { formatDateField } from "../../lib/format-date";
import { ToolPolicySkeleton } from "../loading-skeletons";
import { ErrorState } from "../page-states";
import { OptionSelect } from "../app-ui/option-select";
import { SettingsGroup } from "../settings/setting-row";

type CatalogTool = { name: string; status?: string };

export function IntegrationToolPolicySection({
  packageId,
  tools,
}: {
  packageId: string;
  /** The detail's `tool_catalog`: the statuses that say which tools wait. */
  tools: readonly CatalogTool[];
}) {
  const { can } = usePermissions();
  const canConfigure = can("integrations:configure");
  const query = useIntegrationToolPolicy(packageId, canConfigure);
  const actions = useIntegrationToolPolicyActions(packageId);
  if (!canConfigure) return null;
  if (query.isLoading) return <ToolPolicySkeleton />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  return (
    <ToolPolicyView
      policy={query.data}
      tools={tools}
      busy={actions.isPending}
      onApprove={(item) => actions.approve(approvalBody(item))}
      onBlock={(name) => actions.block(blockBody(name))}
      onRevoke={actions.revoke}
      onUnblock={actions.unblock}
    />
  );
}

/** The section's structure; `ToolPolicySkeleton` stands for it while the policy loads. */
export function ToolPolicyView({
  policy,
  tools,
  busy,
  onApprove,
  onBlock,
  onRevoke,
  onUnblock,
}: {
  policy: ToolPolicy;
  tools: readonly CatalogTool[];
  busy: boolean;
  onApprove: (item: ReviewItem) => void;
  onBlock: (name: string) => void;
  onRevoke: (name: string) => void;
  onUnblock: (name: string) => void;
}) {
  const { t } = useTranslation("agents");
  const items = reviewItems(tools, policy);
  const approvedNames = [...new Set(policy.approvals.map((approval) => approval.tool_name))];
  const blockable = blockableTools(tools, policy.blocks);
  return (
    <div className="flex flex-col gap-2" data-testid="integration-tool-policy">
      <SettingsGroup title={t("integrationTools.policy.review.title")}>
        <p className="text-muted-foreground mb-3 text-sm">
          {t("integrationTools.policy.review.description")}
        </p>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("integrationTools.policy.review.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li
                key={`${item.name}:${item.fingerprint}`}
                className="flex flex-col gap-3 rounded-lg border p-4"
                data-testid={`tool-review-${item.name}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium break-words">{item.name}</span>
                    {item.description && (
                      <span className="text-muted-foreground text-sm break-words">
                        {item.description}
                      </span>
                    )}
                    {item.approved && (
                      <Badge variant="outline" className="w-fit">
                        {t("integrationTools.policy.review.changed")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(item)}>
                      {t("integrationTools.policy.approve")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onBlock(item.name)}
                    >
                      {t("integrationTools.policy.block")}
                    </Button>
                  </div>
                </div>
                <DefinitionCompare item={item} />
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {approvedNames.length > 0 && (
        <SettingsGroup title={t("integrationTools.policy.approved.title")}>
          <ul className="divide-y rounded-lg border">
            {approvedNames.map((name) => {
              const latest = policy.approvals
                .filter((approval) => approval.tool_name === name)
                .reduce((a, b) => (a.approved_at > b.approved_at ? a : b));
              return (
                <ToolRow
                  key={name}
                  name={name}
                  meta={t("integrationTools.policy.approved.since", {
                    date: formatDateField(latest.approved_at),
                  })}
                  action={t("integrationTools.policy.revoke")}
                  busy={busy}
                  onAction={() => onRevoke(name)}
                />
              );
            })}
          </ul>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("integrationTools.policy.blocked.title")}>
        <p className="text-muted-foreground mb-3 text-sm">
          {t("integrationTools.policy.blocked.description")}
        </p>
        {policy.blocks.length > 0 && (
          <ul className="mb-3 divide-y rounded-lg border">
            {policy.blocks.map((block) => (
              <ToolRow
                key={block.tool_name}
                name={block.tool_name}
                meta={t("integrationTools.policy.blocked.since", {
                  date: formatDateField(block.blocked_at),
                })}
                action={t("integrationTools.policy.unblock")}
                busy={busy}
                onAction={() => onUnblock(block.tool_name)}
              />
            ))}
          </ul>
        )}
        {blockable.length > 0 && (
          <OptionSelect
            value={undefined}
            onValueChange={onBlock}
            disabled={busy}
            className="max-w-sm"
            placeholder={t("integrationTools.policy.blocked.add")}
            aria-label={t("integrationTools.policy.blocked.add")}
            options={blockable.map((name) => ({ value: name, label: name }))}
          />
        )}
      </SettingsGroup>
    </div>
  );
}

function ToolRow({
  name,
  meta,
  action,
  busy,
  onAction,
}: {
  name: string;
  meta: string;
  action: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 p-3"
      data-testid={`tool-policy-${name}`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium break-words">{name}</span>
        <span className="text-muted-foreground text-xs">{meta}</span>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAction}>
        {action}
      </Button>
    </li>
  );
}

/** The listed definition, beside the approved one when this replaces it. */
function DefinitionCompare({ item }: { item: ReviewItem }) {
  const { t } = useTranslation("agents");
  return (
    <details>
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
        {t("integrationTools.policy.review.definition")}
      </summary>
      <div className={item.approved ? "mt-2 grid gap-3 md:grid-cols-2" : "mt-2"}>
        {item.approved && (
          <Definition
            label={t("integrationTools.policy.review.approvedDefinition")}
            definition={item.approved.definition}
          />
        )}
        <Definition
          label={t("integrationTools.policy.review.currentDefinition")}
          definition={item.definition}
        />
      </div>
    </details>
  );
}

function Definition({
  label,
  definition,
}: {
  label: string;
  definition: ReviewItem["definition"];
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {definition ? (
        <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs">
          {JSON.stringify(definition, null, 2)}
        </pre>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("integrationTools.policy.review.definitionTooLarge")}
        </p>
      )}
    </div>
  );
}
