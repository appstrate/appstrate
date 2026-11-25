// SPDX-License-Identifier: Apache-2.0

/**
 * The working space's verdict on a remote integration's tools: the undeclared tools the server
 * lists that wait for a review (approve or block), the definitions approved, the tools blocked.
 * What the agents may call follows from it (`tool_catalog` statuses); only a reader who may
 * configure the integration in the space sees it. An author editing the draft also reads the
 * listed tools here, to declare them in the integration.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  useIntegrationToolPolicy,
  useIntegrationToolPolicyActions,
} from "../../hooks/use-integrations";
import {
  approvalBody,
  blockBody,
  blockableTools,
  canonicalDefinitionJson,
  declarableTools,
  latestApprovals,
  reviewItems,
  type ReviewItem,
  type ToolPolicy,
} from "../../lib/integration-tool-policy";
import { formatDateField } from "../../lib/format-date";
import { ConfirmModal } from "../confirm-modal";
import { DraftDiffView } from "../draft-diff-view";
import { JsonView } from "../json-view";
import { ToolPolicySkeleton } from "../loading-skeletons";
import { ErrorState } from "../page-states";
import { OptionSelect } from "../app-ui/option-select";
import { SettingsGroup } from "../settings/setting-row";

type CatalogTool = { name: string; status?: string; origin?: string };

/** What the draft editor lends the review: the declared names and the way to declare more. */
export interface ToolDeclaration {
  declared: ReadonlySet<string>;
  declare: (names: string[]) => void;
}

export function IntegrationToolPolicySection({
  packageId,
  tools,
  review,
  declaration,
}: {
  packageId: string;
  /** The detail's `tool_catalog`: the statuses that say which tools wait. */
  tools: readonly CatalogTool[];
  /** The working space's decisions (approve, block) are offered: the caller's verdict. */
  review: boolean;
  /** Present when the reader edits the draft: tools can be declared in the integration. */
  declaration?: ToolDeclaration;
}) {
  const query = useIntegrationToolPolicy(packageId, review || !!declaration);
  const actions = useIntegrationToolPolicyActions(packageId);
  if (!review && !declaration) return null;
  if (query.isLoading) return <ToolPolicySkeleton review={review} />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  return (
    <ToolPolicyView
      policy={query.data}
      tools={tools}
      review={review}
      declaration={declaration}
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
  review,
  declaration,
  busy,
  onApprove,
  onBlock,
  onRevoke,
  onUnblock,
}: {
  policy: ToolPolicy;
  tools: readonly CatalogTool[];
  /** Approve, block and their lists: the space's decisions. */
  review: boolean;
  declaration?: ToolDeclaration;
  busy: boolean;
  onApprove: (item: { name: string; fingerprint: string }) => void;
  onBlock: (name: string) => void;
  onRevoke: (name: string) => void;
  onUnblock: (name: string) => void;
}) {
  const { t } = useTranslation("agents");
  // Blocking and withdrawing an approval take a tool from every agent of the space, like
  // deactivating a package there (which asks): they ask too. Approving and unblocking give back.
  const [confirm, setConfirm] = useState<{ kind: "block" | "revoke"; name: string } | null>(null);
  const items = review ? reviewItems(tools, policy) : [];
  const declarable = declaration ? declarableTools(tools) : [];
  const declarableSet = new Set(declarable);
  const reviewed = new Set(items.map((item) => item.name));
  const unreviewed = declarable.filter((name) => !reviewed.has(name));
  const toDeclare = declarable.filter((name) => !declaration?.declared.has(name));
  const approved = [...latestApprovals(policy.approvals).values()];
  const blockable = blockableTools(tools, policy.blocks);
  return (
    <div className="flex flex-col gap-2" data-testid="integration-tool-policy">
      {declaration && toDeclare.length > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => declaration.declare(toDeclare)}
            data-testid="tool-declare-all"
          >
            {t("integrationTools.policy.declare.all")}
          </Button>
        </div>
      )}
      {review && (
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
              {items.map((item) => {
                const { fingerprint } = item;
                return (
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
                        {fingerprint !== null && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy}
                            onClick={() => onApprove({ name: item.name, fingerprint })}
                          >
                            {t("integrationTools.policy.approve")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirm({ kind: "block", name: item.name })}
                        >
                          {t("integrationTools.policy.block")}
                        </Button>
                      </div>
                    </div>
                    {declaration && declarableSet.has(item.name) && (
                      <DeclareControl name={item.name} declaration={declaration} />
                    )}
                    <DefinitionCompare item={item} />
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsGroup>
      )}

      {declaration && unreviewed.length > 0 && (
        <SettingsGroup title={t("integrationTools.policy.declare.title")}>
          <p className="text-muted-foreground mb-3 text-sm">
            {t("integrationTools.policy.declare.description")}
          </p>
          <ul className="divide-y rounded-lg border">
            {unreviewed.map((name) => (
              <li
                key={name}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
                data-testid={`tool-undeclared-${name}`}
              >
                <span className="min-w-0 text-sm font-medium break-words">{name}</span>
                <DeclareControl name={name} declaration={declaration} />
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}

      {review && approved.length > 0 && (
        <SettingsGroup title={t("integrationTools.policy.approved.title")}>
          <ul className="divide-y rounded-lg border">
            {approved.map((approval) => (
              <ToolRow
                key={approval.tool_name}
                name={approval.tool_name}
                meta={t("integrationTools.policy.approved.since", {
                  date: formatDateField(approval.approved_at),
                })}
                action={t("integrationTools.policy.revoke")}
                busy={busy}
                onAction={() => setConfirm({ kind: "revoke", name: approval.tool_name })}
              />
            ))}
          </ul>
        </SettingsGroup>
      )}

      {review && (
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
              onValueChange={(name) => setConfirm({ kind: "block", name })}
              disabled={busy}
              className="max-w-sm"
              placeholder={t("integrationTools.policy.blocked.add")}
              aria-label={t("integrationTools.policy.blocked.add")}
              options={blockable.map((name) => ({ value: name, label: name }))}
            />
          )}
        </SettingsGroup>
      )}

      <ConfirmModal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === "revoke"
            ? t("integrationTools.policy.confirm.revoke.title", { name: confirm.name })
            : t("integrationTools.policy.confirm.block.title", { name: confirm?.name })
        }
        description={
          confirm?.kind === "revoke"
            ? t("integrationTools.policy.confirm.revoke.description")
            : t("integrationTools.policy.confirm.block.description")
        }
        confirmLabel={t(
          confirm?.kind === "revoke"
            ? "integrationTools.policy.revoke"
            : "integrationTools.policy.block",
        )}
        isPending={busy}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "block") onBlock(confirm.name);
          else onRevoke(confirm.name);
          setConfirm(null);
        }}
      />
    </div>
  );
}

/** The author's action on one tool: declare it in the draft, or say it already is. */
function DeclareControl({ name, declaration }: { name: string; declaration: ToolDeclaration }) {
  const { t } = useTranslation("agents");
  if (declaration.declared.has(name)) {
    return (
      <p className="text-muted-foreground text-sm" data-testid={`tool-declared-${name}`}>
        {t("integrationTools.policy.declare.declared")}
      </p>
    );
  }
  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => declaration.declare([name])}
        data-testid={`tool-declare-${name}`}
      >
        {t("integrationTools.policy.declare.button")}
      </Button>
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

/** The listed definition: as a diff against the approved one when this replaces it, as is otherwise. */
function DefinitionCompare({ item }: { item: ReviewItem }) {
  const { t } = useTranslation("agents");
  if (item.fingerprint === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("integrationTools.policy.review.notListed")}
      </p>
    );
  }
  const current = item.definition;
  const previous = item.approved?.definition ?? null;
  return (
    <details>
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
        {t("integrationTools.policy.review.definition")}
      </summary>
      <div className="mt-2" data-testid={`tool-definition-${item.name}`}>
        {current === null ? (
          <p className="text-muted-foreground text-sm">
            {t("integrationTools.policy.review.definitionTooLarge")}
          </p>
        ) : previous !== null ? (
          <DraftDiffView
            language="json"
            original={canonicalDefinitionJson(previous)}
            modified={canonicalDefinitionJson(current)}
            originalLabel={t("integrationTools.policy.review.approvedDefinition")}
            modifiedLabel={t("integrationTools.policy.review.currentDefinition")}
          />
        ) : (
          <JsonView data={current} />
        )}
      </div>
    </details>
  );
}
