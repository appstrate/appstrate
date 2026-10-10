// SPDX-License-Identifier: Apache-2.0

/**
 * The model-provider credentials table, shared by the organization page and the
 * caller's own Preferences page. Its rows are whatever the caller may see: an
 * administrator's list holds the organization's rows, a member's only their own.
 */

import { useTranslation } from "react-i18next";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { useConnectionTest } from "../hooks/use-connection-test";
import {
  useProvidersRegistry,
  useTestModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../hooks/use-model-provider-credentials";
import { getProviderIcon } from "./icons";
import { EmptyState, ErrorState, LoadingState } from "./page-states";
import { SourceBadge } from "./source-badge";
import { Spinner } from "./spinner";
import { TestResultSpan } from "./test-result-span";
import { formatDateField } from "../lib/format-date";
import { resolveProviderEntry } from "../lib/provider-registry-helpers";

export function CredentialsSection({
  credentials,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onConnectOAuth,
  canWrite,
  canDelete,
  userId,
  showOwner,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
  canWrite: boolean;
  canDelete: boolean;
  /** The caller: a personal credential is editable only by its owner. */
  userId: string | undefined;
  /** Whether the owner column shows; a personal-only list has one owner, the caller. */
  showOwner: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  const isOwnCredential = (pk: ModelProviderCredentialInfo) =>
    pk.owner_type === "user" && pk.owner_id === userId;
  // A personal credential is changed by its holder alone (404 to anyone else),
  // so an admin's write right covers the organization's rows only.
  const canEditCredential = (pk: ModelProviderCredentialInfo) =>
    pk.owner_type === "org" ? canWrite : isOwnCredential(pk);

  // Single entry point — the unified modal handles both API-key and OAuth
  // flows. Removing a module from `MODULES` hides its OAuth tile from the
  // in-modal provider picker with zero UI footprint here.
  const addButton = canWrite ? <Button onClick={onCreate}>{t("credentials.add")}</Button> : null;

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center justify-end gap-2">{addButton}</div>

      {credentials && credentials.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("credentials.col.provider")}</TableHead>
                {showOwner && (
                  <TableHead className="text-xs">{t("credentials.col.owner")}</TableHead>
                )}
                <TableHead className="text-xs">{t("credentials.col.auth")}</TableHead>
                <TableHead className="text-xs">{t("credentials.col.created")}</TableHead>
                <TableHead className="text-xs">{t("credentials.col.status")}</TableHead>
                <TableHead className="w-px text-right text-xs">
                  {t("credentials.col.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map((pk) => {
                const ProviderIcon = getProviderIcon(resolveProviderEntry(pk, registry ?? []));
                const isOauth = pk.authMode === "oauth2";
                const editButton = (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => onEdit(pk)}
                    aria-label={t("credentials.edit")}
                  >
                    <Pencil size={14} />
                  </Button>
                );
                return (
                  <TableRow key={pk.id} data-testid={`credential-row-${pk.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {ProviderIcon && (
                          <ProviderIcon className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{pk.label}</div>
                          {isOauth && pk.oauth_email && (
                            <div className="text-muted-foreground truncate text-[0.65rem]">
                              {t("credentials.oauth.connectedAs", { email: pk.oauth_email })}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    {showOwner && (
                      <TableCell className="text-sm">
                        {pk.owner_type === "org" ? t("source.org") : (pk.owner_name ?? "—")}
                      </TableCell>
                    )}
                    <TableCell>
                      {isOauth ? (
                        <Badge variant="secondary">{t("credentials.oauth.badgeOauth")}</Badge>
                      ) : (
                        <SourceBadge source={pk.source} />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {pk.createdAt ? formatDateField(pk.createdAt) : "—"}
                    </TableCell>
                    <TableCell>
                      {pk.needs_reconnection ? (
                        // The flag also fires on a stored secret that no longer
                        // decrypts, which reaches api-key credentials — where
                        // the fix is to re-enter the key (Edit), not to
                        // reconnect an account.
                        <Badge variant="destructive">
                          {isOauth
                            ? t("credentials.oauth.needsReconnection")
                            : t("models.credentialUnavailable")}
                        </Badge>
                      ) : pk.source === "built-in" ? (
                        <span className="text-muted-foreground text-xs">{t("source.builtIn")}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {testResults[pk.id] && (
                          <TestResultSpan
                            result={testResults[pk.id]!}
                            successKey="credentials.testSuccess"
                            failedKey="credentials.testFailed"
                          />
                        )}
                        {!isOauth && pk.source === "custom" && canEditCredential(pk) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleTest(pk.id)}
                            disabled={testingId === pk.id}
                          >
                            {testingId === pk.id ? <Spinner /> : t("credentials.test")}
                          </Button>
                        )}
                        {pk.source === "custom" && !isOauth && (
                          <>
                            {canEditCredential(pk) && editButton}
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => onDelete(pk)}
                                aria-label={t("credentials.delete")}
                              >
                                <Trash2 size={14} className="text-destructive" />
                              </Button>
                            )}
                          </>
                        )}
                        {isOauth && (
                          <>
                            {canEditCredential(pk) && editButton}
                            {pk.needs_reconnection && pk.providerId && isOwnCredential(pk) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => onConnectOAuth(pk)}
                              >
                                {t("credentials.oauth.reconnect")}
                              </Button>
                            )}
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => onDelete(pk)}
                                aria-label={t("credentials.oauth.disconnect")}
                              >
                                <Trash2 size={14} className="text-destructive" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          message={t("credentials.empty")}
          hint={t("credentials.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addButton}
        </EmptyState>
      )}
    </div>
  );
}
