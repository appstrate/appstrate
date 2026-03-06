import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { useCreateProvider } from "../hooks/use-mutations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink, Copy, Check } from "lucide-react";
import type { ProviderTemplate } from "@appstrate/shared-types";

interface ProviderTemplateFormProps {
  open: boolean;
  onClose: () => void;
  template: ProviderTemplate;
  callbackUrl: string;
}

export function ProviderTemplateForm({
  open,
  onClose,
  template,
  callbackUrl,
}: ProviderTemplateFormProps) {
  if (!open) return null;

  return (
    <ProviderTemplateFormBody
      key={template.templateId}
      onClose={onClose}
      template={template}
      callbackUrl={callbackUrl}
    />
  );
}

function ProviderTemplateFormBody({
  onClose,
  template,
  callbackUrl,
}: Omit<ProviderTemplateFormProps, "open">) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateProvider();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, setCopied] = useState(false);

  const isOAuth = template.authMode === "oauth2" || template.authMode === "oauth1";

  const handleCopy = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const data: Record<string, unknown> = {
      id: template.templateId,
      displayName: template.displayName,
      authMode: template.authMode,
      iconUrl: template.iconUrl,
      categories: template.categories,
      docsUrl: template.docsUrl,
      ...template.providerDefaults,
    };

    if (isOAuth && clientId) data.clientId = clientId;
    if (isOAuth && clientSecret) data.clientSecret = clientSecret;

    createMutation.mutate(data, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("providers.templates.form.title", { name: template.displayName })}
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Setup Guide */}
          <div className="rounded-lg bg-muted/50 p-4">
            <h4 className="font-medium text-sm mb-2">{t("providers.templates.form.setupGuide")}</h4>
            <ol className="list-decimal pl-4 space-y-2 text-sm text-muted-foreground">
              {template.setupGuide.steps.map((step, i) => (
                <li key={i}>
                  <strong className="text-foreground">{step.title}</strong>
                  <p>{step.description}</p>
                  {step.link && (
                    <a
                      href={step.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary text-xs hover:underline mt-1"
                    >
                      {step.linkLabel || step.link}
                      <ExternalLink size={12} />
                    </a>
                  )}
                </li>
              ))}
            </ol>

            {isOAuth && (
              <div className="mt-3 pt-3 border-t border-border">
                <Label className="text-xs text-muted-foreground">
                  {t("providers.templates.form.callbackUrl")}
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 rounded bg-background px-2 py-1 text-xs font-mono text-foreground border border-border overflow-x-auto">
                    {callbackUrl}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleCopy}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </Button>
                </div>
                {template.setupGuide.callbackUrlHint && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {template.setupGuide.callbackUrlHint.replace("{{callbackUrl}}", callbackUrl)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Credential Fields */}
          {isOAuth ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t("providers.form.clientId")}</Label>
                <Input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label>{t("providers.form.clientSecret")}</Label>
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("providers.templates.form.noCredsNeeded")}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common:btn.cancel")}
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("providers.templates.form.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
