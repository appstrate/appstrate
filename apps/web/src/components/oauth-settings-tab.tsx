// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Plus, X, Copy, Check, ExternalLink } from "lucide-react";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { useOAuthConfig, useUpdateOAuth, useDisableOAuth } from "../hooks/use-oauth-config";
import { OAuthEnableModal } from "./oauth-enable-modal";
import { ConfirmModal } from "./confirm-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState, ErrorState } from "./page-states";
import { Spinner } from "./spinner";

interface Props {
  appId: string;
}

export function OAuthSettingsTab({ appId }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: config, isLoading, error } = useOAuthConfig(appId);
  const [enableModalOpen, setEnableModalOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  if (!config?.enabled) {
    return (
      <>
        <div className="max-w-xl space-y-4">
          <div className="border-border bg-card rounded-lg border p-6 text-center">
            <KeyRound size={40} className="text-muted-foreground mx-auto mb-3" />
            <h3 className="text-sm font-semibold">{t("oauth.title")}</h3>
            <p className="text-muted-foreground mt-1 text-sm">{t("oauth.notEnabled")}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t("oauth.description")}</p>
            <Button className="mt-4" onClick={() => setEnableModalOpen(true)}>
              {t("oauth.enableBtn")}
            </Button>
          </div>
        </div>
        <OAuthEnableModal
          open={enableModalOpen}
          onClose={() => setEnableModalOpen(false)}
          appId={appId}
        />
      </>
    );
  }

  return (
    <EnabledConfigView
      appId={appId}
      clientId={config.clientId!}
      redirectUris={config.redirectUris ?? []}
      allowSignup={config.allowSignup ?? true}
    />
  );
}

function EnabledConfigView({
  appId,
  clientId,
  redirectUris: initialUris,
  allowSignup: initialAllowSignup,
}: {
  appId: string;
  clientId: string;
  redirectUris: string[];
  allowSignup: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const updateMutation = useUpdateOAuth();
  const disableMutation = useDisableOAuth();
  const { copied, copy } = useCopyToClipboard();

  const [editedUris, setEditedUris] = useState<string[] | null>(null);
  const [allowSignup, setAllowSignup] = useState(initialAllowSignup);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const activeUris = editedUris ?? initialUris;
  const discoveryUrl = `${window.location.origin}/.well-known/openid-configuration`;

  const hasChanges = editedUris !== null || allowSignup !== initialAllowSignup;

  const handleSave = () => {
    const data: { redirectUris?: string[]; allowSignup?: boolean } = {};
    if (editedUris !== null) {
      data.redirectUris = editedUris.map((u) => u.trim()).filter(Boolean);
    }
    if (allowSignup !== initialAllowSignup) {
      data.allowSignup = allowSignup;
    }
    updateMutation.mutate({ appId, data }, { onSuccess: () => setEditedUris(null) });
  };

  return (
    <>
      <div className="max-w-xl space-y-6">
        {/* Status */}
        <div className="flex items-center gap-2">
          <Badge variant="success">{t("oauth.enabled")}</Badge>
        </div>

        {/* Client ID */}
        <div className="space-y-2">
          <Label>{t("oauth.clientId")}</Label>
          <div className="border-border bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
            <code className="text-foreground flex-1 font-mono text-sm break-all">{clientId}</code>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary shrink-0 text-xs hover:underline"
              onClick={() => copy(clientId)}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        </div>

        {/* OIDC Discovery */}
        <div className="space-y-2">
          <Label>{t("oauth.oidcDiscovery")}</Label>
          <p className="text-muted-foreground text-sm">{t("oauth.oidcDiscoveryHint")}</p>
          <a
            href={discoveryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
          >
            {discoveryUrl}
            <ExternalLink size={12} />
          </a>
        </div>

        {/* Redirect URIs */}
        <div className="space-y-2">
          <Label>{t("oauth.redirectUris")}</Label>
          <p className="text-muted-foreground text-sm">{t("oauth.redirectUrisHint")}</p>
          <div className="flex flex-col gap-2">
            {activeUris.map((uri, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={uri}
                  onChange={(e) =>
                    setEditedUris((prev) =>
                      (prev ?? initialUris).map((u, i) => (i === index ? e.target.value : u)),
                    )
                  }
                  placeholder="https://myapp.example.com/callback"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setEditedUris((prev) => (prev ?? initialUris).filter((_, i) => i !== index))
                  }
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditedUris((prev) => [...(prev ?? initialUris), ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("oauth.addRedirectUri")}
            </Button>
          </div>
        </div>

        {/* Allow Signup */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="allow-signup"
            checked={allowSignup}
            onChange={(e) => setAllowSignup(e.target.checked)}
            className="rounded"
          />
          <Label htmlFor="allow-signup" className="cursor-pointer">
            {t("oauth.allowSignup")}
          </Label>
        </div>

        {/* Save */}
        {hasChanges && (
          <Button onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? <Spinner /> : t("btn.save")}
          </Button>
        )}

        {/* Danger zone */}
        <div className="text-muted-foreground mt-8 mb-4 text-sm font-medium">
          {t("applications.dangerZone")}
        </div>
        <div className="border-destructive bg-card rounded-lg border p-5">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("oauth.disableTitle")}</h3>
              <span className="text-muted-foreground text-sm">{t("oauth.disableConfirm")}</span>
            </div>
            <Button
              variant="destructive"
              disabled={disableMutation.isPending}
              onClick={() => setConfirmDisable(true)}
            >
              {disableMutation.isPending ? t("applications.deleting") : t("oauth.disableBtn")}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title={t("oauth.disableTitle")}
        description={t("oauth.disableConfirm")}
        isPending={disableMutation.isPending}
        onConfirm={() => {
          disableMutation.mutate(appId, {
            onSuccess: () => setConfirmDisable(false),
          });
        }}
      />
    </>
  );
}
