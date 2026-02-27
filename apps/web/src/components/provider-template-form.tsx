import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { useCreateProvider } from "../hooks/use-mutations";
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
        <div className="template-form-layout">
          {/* Setup Guide */}
          <div className="setup-guide">
            <h4 className="setup-guide-title">{t("providers.templates.form.setupGuide")}</h4>
            <ol className="setup-guide-steps">
              {template.setupGuide.steps.map((step, i) => (
                <li key={i} className="setup-guide-step">
                  <strong>{step.title}</strong>
                  <p>{step.description}</p>
                  {step.link && (
                    <a
                      href={step.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="setup-guide-link"
                    >
                      {step.linkLabel || step.link}
                      <ExternalLink size={12} />
                    </a>
                  )}
                </li>
              ))}
            </ol>

            {isOAuth && (
              <div className="setup-guide-callback">
                <label>{t("providers.templates.form.callbackUrl")}</label>
                <div className="setup-guide-callback-box">
                  <code>{callbackUrl}</code>
                  <button type="button" className="btn-icon" onClick={handleCopy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                {template.setupGuide.callbackUrlHint && (
                  <p className="hint">
                    {template.setupGuide.callbackUrlHint.replace("{{callbackUrl}}", callbackUrl)}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Credential Fields */}
          {isOAuth ? (
            <div className="template-form-fields">
              <div className="form-group">
                <label>{t("providers.form.clientId")}</label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>{t("providers.form.clientSecret")}</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="template-form-fields">
              <p className="service-provider">{t("providers.templates.form.noCredsNeeded")}</p>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t("common:btn.cancel")}
          </button>
          <button type="submit" className="primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("providers.templates.form.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
