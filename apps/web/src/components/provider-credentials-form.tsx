// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useConfigureProviderCredentials } from "../hooks/use-mutations";
import { ExternalLink, Copy, Check } from "lucide-react";
import type { ProviderConfig } from "@appstrate/shared-types";

interface ProviderCredentialsFormProps {
  provider: ProviderConfig;
  callbackUrl?: string;
  onSuccess?: () => void;
  /** Extra buttons rendered before the save button (e.g. cancel in modal context). */
  footer?: ReactNode;
}

type CredentialsFormData = {
  credentials: Record<string, string>;
};

export function ProviderCredentialsForm({
  provider,
  callbackUrl,
  onSuccess,
  footer,
}: ProviderCredentialsFormProps) {
  const { t } = useTranslation(["settings", "common"]);
  const mutation = useConfigureProviderCredentials();
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const schema = provider.adminCredentialSchema;
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const fieldKeys = Object.keys(properties);
  const hasSchemaFields = fieldKeys.length > 0;

  const { register, handleSubmit, control } = useForm<CredentialsFormData>({
    defaultValues: {
      credentials: {},
    },
  });

  const credentials = useWatch({
    control,
    name: "credentials",
  });

  const allRequiredFilled =
    !hasSchemaFields ||
    provider.hasCredentials ||
    required.every((key) => credentials[key]?.trim());

  const guide = provider.setupGuide;
  const resolvedCallbackHint = guide?.callbackUrlHint?.replace(
    "{{callbackUrl}}",
    callbackUrl ?? "",
  );

  const handleCopy = () => {
    if (!callbackUrl) return;
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleVisibility = (key: string) => {
    setVisibleFields((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const onFormSubmit = (data: CredentialsFormData) => {
    if (hasSchemaFields && !allRequiredFilled) return;

    const payload: {
      providerId: string;
      credentials?: Record<string, string>;
      enabled: boolean;
    } = { providerId: provider.id, enabled: true };

    if (hasSchemaFields) {
      const creds: Record<string, string> = {};
      for (const key of fieldKeys) {
        if (data.credentials[key]?.trim()) {
          creds[key] = data.credentials[key].trim();
        }
      }
      if (Object.keys(creds).length > 0) {
        payload.credentials = creds;
      }
    }

    mutation.mutate(payload, { onSuccess });
  };

  return (
    <form onSubmit={handleSubmit(onFormSubmit)}>
      <div className="space-y-4">
        {/* Setup Guide */}
        {guide?.steps && guide.steps.length > 0 && (
          <div className="bg-muted/50 rounded-lg p-4">
            <h4 className="mb-2 text-sm font-medium">{t("providers.form.setupGuide")}</h4>
            <ol className="text-muted-foreground list-decimal space-y-2 pl-4 text-sm">
              {guide.steps.map((step, i) => (
                <li key={i}>
                  <span className="text-foreground">{step.label}</span>
                  {step.url && (
                    <a
                      href={step.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary ml-2 inline-flex items-center gap-1 text-xs hover:underline"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Callback URL — only relevant for OAuth providers */}
        {callbackUrl && (provider.authMode === "oauth2" || provider.authMode === "oauth1") && (
          <div className="bg-muted/50 rounded-lg p-4">
            <Label className="text-muted-foreground text-xs">
              {t("providers.form.callbackUrl")}
            </Label>
            <div className="mt-1 flex items-center gap-2">
              <code className="bg-background text-foreground border-border flex-1 overflow-x-auto rounded border px-2 py-1 font-mono text-xs">
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
            {resolvedCallbackHint && (
              <p className="text-muted-foreground mt-1 text-sm">{resolvedCallbackHint}</p>
            )}
          </div>
        )}

        {/* Dynamic Credential Fields */}
        {hasSchemaFields && (
          <div className="space-y-3">
            {fieldKeys.map((key) => {
              const prop = properties[key];
              const isRequired = required.includes(key);
              const isVisible = visibleFields[key] ?? false;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`admin-cred-${key}`}>
                    {prop?.description || key}
                    {isRequired && " *"}
                  </Label>
                  <div className="flex items-center gap-1">
                    <Input
                      id={`admin-cred-${key}`}
                      type={isVisible ? "text" : "password"}
                      placeholder={
                        provider.hasCredentials ? t("providers.form.secretUnchanged") : undefined
                      }
                      autoFocus={key === fieldKeys[0]}
                      {...register(`credentials.${key}` as const)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground text-sm"
                      onClick={() => toggleVisibility(key)}
                      tabIndex={-1}
                    >
                      {isVisible ? "◡" : "⦿"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-border mt-4 flex items-center border-t pt-4">
        <div className="flex-1">{footer}</div>
        {hasSchemaFields ? (
          <Button type="submit" disabled={mutation.isPending || !allRequiredFilled}>
            {mutation.isPending ? <Spinner /> : t("common:btn.save")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={provider.enabled || mutation.isPending}
            onClick={() => {
              mutation.mutate({ providerId: provider.id, enabled: true }, { onSuccess });
            }}
          >
            {mutation.isPending ? (
              <Spinner />
            ) : provider.enabled ? (
              t("providers.form.activated")
            ) : (
              t("providers.form.activate")
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
