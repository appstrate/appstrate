// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { useEnableOAuth, useInvalidateOAuthConfig } from "../hooks/use-oauth-config";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";

interface Props {
  open: boolean;
  onClose: () => void;
  appId: string;
}

interface CreatedCredentials {
  clientId: string;
  clientSecret: string;
}

export function OAuthEnableModal({ open, onClose, appId }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const enableMutation = useEnableOAuth();
  const invalidateOAuthConfig = useInvalidateOAuthConfig();

  const [redirectUris, setRedirectUris] = useState<string[]>([""]);
  const [allowSignup, setAllowSignup] = useState(true);
  const [created, setCreated] = useState<CreatedCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { copied: copiedId, copy: copyId } = useCopyToClipboard();
  const { copied: copiedSecret, copy: copySecret } = useCopyToClipboard();

  const handleClose = () => {
    // Invalidate queries NOW (after user has seen/copied the secret)
    if (created) {
      invalidateOAuthConfig();
    }
    setRedirectUris([""]);
    setAllowSignup(true);
    setCreated(null);
    setError(null);
    enableMutation.reset();
    onClose();
  };

  const handleSubmit = () => {
    const validUris = redirectUris.map((u) => u.trim()).filter(Boolean);
    if (validUris.length === 0) {
      setError(t("oauth.redirectUriRequired"));
      return;
    }
    setError(null);
    enableMutation.mutate(
      { appId, redirectUris: validUris, allowSignup },
      {
        onSuccess: (result) => {
          setCreated({ clientId: result.clientId, clientSecret: result.clientSecret });
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  };

  // Success state — show credentials one-time
  if (created) {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={t("oauth.enableTitle")}
        className="sm:max-w-lg"
      >
        <p className="text-warning bg-warning/10 rounded-md px-3 py-2 text-sm">
          {t("oauth.secretWarning")}
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <Label className="text-muted-foreground text-xs">{t("oauth.clientId")}</Label>
            <div className="border-border bg-muted/50 mt-1 flex items-center gap-2 rounded-md border px-3 py-2">
              <code className="text-foreground flex-1 font-mono text-xs break-all">
                {created.clientId}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary shrink-0 text-xs hover:underline"
                onClick={() => copyId(created.clientId)}
              >
                {copiedId ? t("btn.copied") : t("btn.copy")}
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-muted-foreground text-xs">{t("oauth.clientSecret")}</Label>
            <div className="border-border bg-muted/50 mt-1 flex items-center gap-2 rounded-md border px-3 py-2">
              <code className="text-foreground flex-1 font-mono text-xs break-all">
                {created.clientSecret}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary shrink-0 text-xs hover:underline"
                onClick={() => copySecret(created.clientSecret)}
              >
                {copiedSecret ? t("btn.copied") : t("btn.copy")}
              </Button>
            </div>
          </div>
        </div>

        <div className="border-border mt-4 flex justify-end gap-2 border-t pt-4">
          <Button onClick={handleClose}>{t("btn.done")}</Button>
        </div>
      </Modal>
    );
  }

  // Form state — configure and enable
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("oauth.enableTitle")}
      className="sm:max-w-lg"
      actions={
        <>
          <Button variant="outline" onClick={handleClose}>
            {t("btn.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={enableMutation.isPending}>
            {enableMutation.isPending ? <Spinner /> : t("oauth.enableBtn")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t("oauth.redirectUris")}</Label>
          <p className="text-muted-foreground text-sm">{t("oauth.redirectUrisHint")}</p>
          <div className="flex flex-col gap-2">
            {redirectUris.map((uri, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={uri}
                  onChange={(e) =>
                    setRedirectUris((prev) =>
                      prev.map((u, i) => (i === index ? e.target.value : u)),
                    )
                  }
                  placeholder="https://myapp.example.com/callback"
                />
                {redirectUris.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setRedirectUris((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <X size={16} />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRedirectUris((prev) => [...prev, ""])}
            >
              <Plus size={14} className="mr-1.5" />
              {t("oauth.addRedirectUri")}
            </Button>
          </div>
        </div>

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

        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    </Modal>
  );
}
