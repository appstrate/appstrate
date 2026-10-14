// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space authentication settings tab.
 *
 * Exposes CRUD for:
 *  - SMTP transport (verification emails, magic-link, password reset for
 *    `level=space` OAuth clients referencing this space)
 *  - Google OAuth App credentials (per-tenant Google sign-in)
 *  - GitHub OAuth App credentials (per-tenant GitHub sign-in)
 *
 * Row absent → feature disabled for this space's OIDC clients. No fallback to
 * instance-level env creds. Secrets are write-only: the backend never
 * returns `pass` / `client_secret`, and every save submits them again.
 *
 * A personal space takes no end-user sign-in (the server refuses the writes),
 * so there a row that exists is shown only to be deleted.
 */

import { useState } from "react";
import { useModalParam } from "@/hooks/use-modal-param";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Mail, Trash2, Send } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@appstrate/ui/components/field";
import { OptionSelect } from "@appstrate/ui/components/select";
import { Badge } from "@appstrate/ui/components/badge";
import { Spinner } from "@/components/spinner";
import { ConfirmModal } from "@/components/confirm-modal";
import { Modal } from "@/components/modal";
import { GitHubIcon, GoogleIcon } from "@/components/icons";
import { usePermissions } from "@/hooks/use-permissions";
import {
  useSmtpConfig,
  useUpsertSmtpConfig,
  useDeleteSmtpConfig,
  useTestSmtp,
  useSocialProvider,
  useUpsertSocialProvider,
  useDeleteSocialProvider,
  type SocialProviderId,
  type SmtpConfigView,
  type SocialProviderView,
} from "../hooks/use-space-auth-config";

export function SpaceAuthTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { inPersonalSpace: personal } = usePermissions();

  return (
    <div className="max-w-2xl space-y-10">
      {personal && (
        <p className="text-muted-foreground text-sm">{t("settings:spaceAuth.personalSpace")}</p>
      )}
      <SmtpSection personal={personal} />
      <SocialSection
        provider="google"
        title={t("settings:spaceAuth.googleTitle")}
        icon="google"
        personal={personal}
      />
      <SocialSection
        provider="github"
        title={t("settings:spaceAuth.githubTitle")}
        icon="github"
        personal={personal}
      />
    </div>
  );
}

// ─── SMTP ────────────────────────────────────────────────────────────────────

function SmtpSection({ personal }: { personal: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: config, isLoading } = useSmtpConfig();
  const upsert = useUpsertSmtpConfig();
  const del = useDeleteSmtpConfig();
  const test = useTestSmtp();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const smtpTest = useModalParam("smtpTest");

  const initial = config ?? null;
  const [form, setForm] = useState(() => emptySmtp());

  // Re-seed form from loaded row on initial fetch.
  const [seededFor, setSeededFor] = useState<string | null | "none">(null);
  const seedKey = config ? config.updatedAt : "none";
  if (!isLoading && seededFor !== seedKey) {
    setForm(config ? fromSmtp(config) : emptySmtp());
    setSeededFor(seedKey);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    upsert.mutate(
      {
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username,
        pass: form.pass,
        from_address: form.fromAddress.trim(),
        from_name: form.fromName.trim() || null,
        secure_mode: form.secureMode,
      },
      {
        onSuccess: () => {
          toast.success(t("settings:spaceAuth.smtpSaved"));
          setForm((f) => ({ ...f, pass: "" }));
        },
      },
    );
  }

  if (personal && !initial) return null;

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Mail className="h-5 w-5" />
          {t("settings:spaceAuth.smtpTitle")}
          {initial ? (
            <Badge variant="running">{t("settings:spaceAuth.configured")}</Badge>
          ) : (
            <Badge variant="secondary">{t("settings:spaceAuth.notConfigured")}</Badge>
          )}
        </h2>
        <p className="text-muted-foreground text-sm">{t("settings:spaceAuth.smtpHint")}</p>
      </header>

      {personal ? (
        <DeleteConfigButton disabled={del.isPending} onClick={() => setConfirmDelete(true)} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormItem id="smtp-host" label={requiredLabel(t("settings:spaceAuth.smtpHost"))}>
              <Input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="smtp.example.com"
                required
              />
            </FormItem>
            <FormItem id="smtp-port" label={requiredLabel(t("settings:spaceAuth.smtpPort"))}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                required
              />
            </FormItem>
            <FormItem
              id="smtp-username"
              label={requiredLabel(t("settings:spaceAuth.smtpUsername"))}
            >
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </FormItem>
            <FormItem
              id="smtp-pass"
              label={requiredLabel(t("settings:spaceAuth.smtpPass"))}
              hint={initial ? t("settings:spaceAuth.smtpPassReuploadHint") : undefined}
            >
              <Input
                type="password"
                value={form.pass}
                onChange={(e) => setForm({ ...form, pass: e.target.value })}
                required
              />
            </FormItem>
            <FormItem
              id="smtp-from-address"
              label={requiredLabel(t("settings:spaceAuth.smtpFromAddress"))}
            >
              <Input
                type="email"
                value={form.fromAddress}
                onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
                placeholder="noreply@tenant.com"
                required
              />
            </FormItem>
            <FormItem id="smtp-from-name" label={t("settings:spaceAuth.smtpFromName")}>
              <Input
                value={form.fromName}
                onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                placeholder={t("settings:spaceAuth.smtpFromNamePlaceholder")}
              />
            </FormItem>
            <FormItem id="smtp-secure-mode" label={t("settings:spaceAuth.smtpSecureMode")}>
              <OptionSelect
                value={form.secureMode}
                onValueChange={(v) =>
                  setForm({ ...form, secureMode: v as SmtpConfigView["secure_mode"] })
                }
                options={[
                  { value: "auto", label: t("settings:spaceAuth.secureModeAuto") },
                  { value: "tls", label: "TLS" },
                  { value: "starttls", label: "STARTTLS" },
                  { value: "none", label: t("settings:spaceAuth.secureModeNone") },
                ]}
              />
            </FormItem>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending ? <Spinner /> : t("common:btn.save")}
            </Button>
            {initial && (
              <>
                <Button type="button" variant="outline" onClick={() => smtpTest.open()}>
                  <Send className="h-4 w-4" />
                  {t("settings:spaceAuth.smtpTest")}
                </Button>
                <DeleteConfigButton
                  disabled={del.isPending}
                  onClick={() => setConfirmDelete(true)}
                />
              </>
            )}
          </div>
        </form>
      )}

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("settings:spaceAuth.smtpDeleteTitle")}
        description={t("settings:spaceAuth.smtpDeleteConfirm")}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast.success(t("settings:spaceAuth.smtpDeleted"));
            },
          })
        }
      />

      <SmtpTestModal
        open={!personal && !!initial && smtpTest.value !== null}
        onClose={smtpTest.close}
        isPending={test.isPending}
        onSend={(to) =>
          test.mutate(to, {
            // A failed SMTP send is a non-2xx response (the server surfaces
            // the SMTP error verbatim), which the mutation cache toasts.
            onSuccess: () => {
              toast.success(t("settings:spaceAuth.smtpTestOk"));
              smtpTest.close();
            },
          })
        }
      />
    </section>
  );
}

function SmtpTestModal({
  open,
  onClose,
  isPending,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  isPending: boolean;
  onSend: (to: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [to, setTo] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings:spaceAuth.smtpTestTitle")}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("common:btn.cancel")}
          </Button>
          <Button onClick={() => onSend(to)} disabled={isPending || !to}>
            {isPending ? <Spinner /> : t("settings:spaceAuth.smtpTest")}
          </Button>
        </>
      }
    >
      <FormItem id="smtp-test-to" label={t("settings:spaceAuth.smtpTestTo")}>
        <Input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="you@example.com"
        />
      </FormItem>
    </Modal>
  );
}

// ─── Social provider ─────────────────────────────────────────────────────────

function SocialSection({
  provider,
  title,
  icon,
  personal,
}: {
  provider: SocialProviderId;
  title: string;
  icon: "google" | "github";
  personal: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: config } = useSocialProvider(provider);
  const upsert = useUpsertSocialProvider(provider);
  const del = useDeleteSocialProvider(provider);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState(() => emptySocial());
  const [seededFor, setSeededFor] = useState<string | "none" | null>(null);
  const seedKey = config ? config.updatedAt : "none";
  if (seededFor !== seedKey) {
    setForm(config ? fromSocial(config) : emptySocial());
    setSeededFor(seedKey);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    upsert.mutate(
      {
        client_id: form.clientId.trim(),
        client_secret: form.clientSecret,
        scopes: form.scopes.trim() ? form.scopes.split(/[\s,]+/).filter(Boolean) : null,
      },
      {
        onSuccess: () => {
          toast.success(t("settings:spaceAuth.socialSaved"));
          setForm((f) => ({ ...f, clientSecret: "" }));
        },
      },
    );
  }

  if (personal && !config) return null;

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon === "github" ? (
            <GitHubIcon className="h-5 w-5" aria-hidden />
          ) : (
            <GoogleIcon className="h-5 w-5" aria-hidden />
          )}
          {title}
          {config ? (
            <Badge variant="running">{t("settings:spaceAuth.configured")}</Badge>
          ) : (
            <Badge variant="secondary">{t("settings:spaceAuth.notConfigured")}</Badge>
          )}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("settings:spaceAuth.socialHint", { provider: title })}
        </p>
      </header>

      {personal ? (
        <DeleteConfigButton disabled={del.isPending} onClick={() => setConfirmDelete(true)} />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <FormItem id={`${provider}-client-id`} label={requiredLabel("Client ID")}>
            <Input
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              required
            />
          </FormItem>
          <FormItem
            id={`${provider}-client-secret`}
            label={requiredLabel("Client Secret")}
            hint={config ? t("settings:spaceAuth.socialSecretReuploadHint") : undefined}
          >
            <Input
              type="password"
              value={form.clientSecret}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              required
            />
          </FormItem>
          <FormItem
            id={`${provider}-scopes`}
            label={t("settings:spaceAuth.socialScopes")}
            hint={t("settings:spaceAuth.socialScopesHint")}
          >
            <Input
              value={form.scopes}
              onChange={(e) => setForm({ ...form, scopes: e.target.value })}
              placeholder={provider === "google" ? "openid email profile" : "read:user user:email"}
            />
          </FormItem>

          <div className="flex gap-2">
            <Button type="submit" disabled={upsert.isPending}>
              {upsert.isPending ? <Spinner /> : t("common:btn.save")}
            </Button>
            {config && (
              <DeleteConfigButton disabled={del.isPending} onClick={() => setConfirmDelete(true)} />
            )}
          </div>
        </form>
      )}

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("settings:spaceAuth.socialDeleteTitle")}
        description={t("settings:spaceAuth.socialDeleteConfirm", { provider: title })}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast.success(t("settings:spaceAuth.socialDeleted"));
            },
          })
        }
      />
    </section>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────

function DeleteConfigButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Button type="button" variant="destructive" onClick={onClick} disabled={disabled}>
      <Trash2 className="h-4 w-4" />
      {t("btn.delete")}
    </Button>
  );
}

/** A field's label, with the red « * » that marks it required. */
function requiredLabel(text: string) {
  return (
    <>
      {text}
      <span className="text-destructive"> *</span>
    </>
  );
}

function emptySmtp() {
  return {
    host: "",
    port: "587",
    username: "",
    pass: "",
    fromAddress: "",
    fromName: "",
    secureMode: "auto" as SmtpConfigView["secure_mode"],
  };
}

function fromSmtp(c: SmtpConfigView) {
  return {
    host: c.host,
    port: String(c.port),
    username: c.username,
    pass: "",
    fromAddress: c.from_address,
    fromName: c.from_name ?? "",
    secureMode: c.secure_mode,
  };
}

function emptySocial() {
  return { clientId: "", clientSecret: "", scopes: "" };
}

function fromSocial(c: SocialProviderView) {
  return {
    clientId: c.client_id,
    clientSecret: "",
    scopes: (c.scopes ?? []).join(" "),
  };
}
