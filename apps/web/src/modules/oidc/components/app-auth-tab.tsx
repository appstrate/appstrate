// SPDX-License-Identifier: Apache-2.0

/**
 * Per-application authentication settings tab.
 *
 * Exposes CRUD for:
 *  - SMTP transport (verification emails, magic-link, password reset for
 *    `level=application` OAuth clients referencing this app)
 *  - Google OAuth App credentials (per-tenant Google sign-in)
 *  - GitHub OAuth App credentials (per-tenant GitHub sign-in)
 *
 * Row absent → feature disabled for this app's OIDC clients. No fallback to
 * instance-level env creds. Secrets are write-only: the backend never
 * returns `pass` / `clientSecret`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Mail, Trash2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/spinner";
import { ConfirmModal } from "@/components/confirm-modal";
import { Modal } from "@/components/modal";
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
} from "../hooks/use-app-auth-config";

export function AppAuthTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  if (!isAdmin) return null;

  return (
    <div className="max-w-2xl space-y-10">
      <SmtpSection />
      <SocialSection provider="google" title={t("settings:appAuth.googleTitle")} icon="google" />
      <SocialSection provider="github" title={t("settings:appAuth.githubTitle")} icon="github" />
    </div>
  );
}

// ─── SMTP ────────────────────────────────────────────────────────────────────

function SmtpSection() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: config, isLoading } = useSmtpConfig();
  const upsert = useUpsertSmtpConfig();
  const del = useDeleteSmtpConfig();
  const test = useTestSmtp();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

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
        fromAddress: form.fromAddress.trim(),
        fromName: form.fromName.trim() || null,
        secureMode: form.secureMode,
      },
      {
        onSuccess: () => {
          toast.success(t("settings:appAuth.smtpSaved"));
          setForm((f) => ({ ...f, pass: "" }));
        },
        onError: (err) => toast.error((err as Error).message),
      },
    );
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Mail className="h-5 w-5" />
          {t("settings:appAuth.smtpTitle")}
          {initial ? (
            <Badge variant="running">{t("settings:appAuth.configured")}</Badge>
          ) : (
            <Badge variant="secondary">{t("settings:appAuth.notConfigured")}</Badge>
          )}
        </h2>
        <p className="text-muted-foreground text-sm">{t("settings:appAuth.smtpHint")}</p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("settings:appAuth.smtpHost")} required>
            <Input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="smtp.example.com"
              required
            />
          </Field>
          <Field label={t("settings:appAuth.smtpPort")} required>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
              required
            />
          </Field>
          <Field label={t("settings:appAuth.smtpUsername")} required>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
          </Field>
          <Field
            label={t("settings:appAuth.smtpPass")}
            required={!initial}
            hint={initial ? t("settings:appAuth.smtpPassReuploadHint") : undefined}
          >
            <Input
              type="password"
              value={form.pass}
              onChange={(e) => setForm({ ...form, pass: e.target.value })}
              placeholder={initial ? "••••••••" : undefined}
              required={!initial}
            />
          </Field>
          <Field label={t("settings:appAuth.smtpFromAddress")} required>
            <Input
              type="email"
              value={form.fromAddress}
              onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
              placeholder="noreply@tenant.com"
              required
            />
          </Field>
          <Field label={t("settings:appAuth.smtpFromName")}>
            <Input
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder={t("settings:appAuth.smtpFromNamePlaceholder")}
            />
          </Field>
          <Field label={t("settings:appAuth.smtpSecureMode")}>
            <Select
              value={form.secureMode}
              onValueChange={(v) =>
                setForm({ ...form, secureMode: v as SmtpConfigView["secureMode"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("settings:appAuth.secureModeAuto")}</SelectItem>
                <SelectItem value="tls">TLS</SelectItem>
                <SelectItem value="starttls">STARTTLS</SelectItem>
                <SelectItem value="none">{t("settings:appAuth.secureModeNone")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={upsert.isPending}>
            {upsert.isPending ? <Spinner /> : t("common:btn.save")}
          </Button>
          {initial && (
            <>
              <Button type="button" variant="outline" onClick={() => setTestOpen(true)}>
                <Send className="h-4 w-4" />
                {t("settings:appAuth.smtpTest")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={del.isPending}
              >
                <Trash2 className="h-4 w-4" />
                {t("common:btn.delete")}
              </Button>
            </>
          )}
        </div>
      </form>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("settings:appAuth.smtpDeleteTitle")}
        description={t("settings:appAuth.smtpDeleteConfirm")}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast.success(t("settings:appAuth.smtpDeleted"));
            },
          })
        }
      />

      <SmtpTestModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        isPending={test.isPending}
        onSend={(to) =>
          test.mutate(to, {
            onSuccess: (r) => {
              if (r.ok) {
                toast.success(t("settings:appAuth.smtpTestOk"));
                setTestOpen(false);
              } else {
                toast.error(r.error ?? "SMTP test failed");
              }
            },
            onError: (err) => toast.error((err as Error).message),
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
      title={t("settings:appAuth.smtpTestTitle")}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("common:btn.cancel")}
          </Button>
          <Button onClick={() => onSend(to)} disabled={isPending || !to}>
            {isPending ? <Spinner /> : t("settings:appAuth.smtpTest")}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label>{t("settings:appAuth.smtpTestTo")}</Label>
        <Input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="you@example.com"
        />
      </div>
    </Modal>
  );
}

// ─── Social provider ─────────────────────────────────────────────────────────

function SocialSection({
  provider,
  title,
  icon,
}: {
  provider: SocialProviderId;
  title: string;
  icon: "google" | "github";
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
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret,
        scopes: form.scopes.trim() ? form.scopes.split(/[\s,]+/).filter(Boolean) : null,
      },
      {
        onSuccess: () => {
          toast.success(t("settings:appAuth.socialSaved"));
          setForm((f) => ({ ...f, clientSecret: "" }));
        },
        onError: (err) => toast.error((err as Error).message),
      },
    );
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon === "github" ? <GithubIcon /> : <GoogleIcon />}
          {title}
          {config ? (
            <Badge variant="running">{t("settings:appAuth.configured")}</Badge>
          ) : (
            <Badge variant="secondary">{t("settings:appAuth.notConfigured")}</Badge>
          )}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("settings:appAuth.socialHint", { provider: title })}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Client ID" required>
          <Input
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            required
          />
        </Field>
        <Field
          label="Client Secret"
          required={!config}
          hint={config ? t("settings:appAuth.socialSecretReuploadHint") : undefined}
        >
          <Input
            type="password"
            value={form.clientSecret}
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            placeholder={config ? "••••••••" : undefined}
            required={!config}
          />
        </Field>
        <Field
          label={t("settings:appAuth.socialScopes")}
          hint={t("settings:appAuth.socialScopesHint")}
        >
          <Input
            value={form.scopes}
            onChange={(e) => setForm({ ...form, scopes: e.target.value })}
            placeholder={provider === "google" ? "openid email profile" : "read:user user:email"}
          />
        </Field>

        <div className="flex gap-2">
          <Button type="submit" disabled={upsert.isPending}>
            {upsert.isPending ? <Spinner /> : t("common:btn.save")}
          </Button>
          {config && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={del.isPending}
            >
              <Trash2 className="h-4 w-4" />
              {t("common:btn.delete")}
            </Button>
          )}
        </div>
      </form>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("settings:appAuth.socialDeleteTitle")}
        description={t("settings:appAuth.socialDeleteConfirm", { provider: title })}
        isPending={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast.success(t("settings:appAuth.socialDeleted"));
            },
          })
        }
      />
    </section>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden fill="currentColor">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2.9-.3 2-.4 3-.4s2.1.1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.1 0 4.5-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.45.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
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
    secureMode: "auto" as SmtpConfigView["secureMode"],
  };
}

function fromSmtp(c: SmtpConfigView) {
  return {
    host: c.host,
    port: String(c.port),
    username: c.username,
    pass: "",
    fromAddress: c.fromAddress,
    fromName: c.fromName ?? "",
    secureMode: c.secureMode,
  };
}

function emptySocial() {
  return { clientId: "", clientSecret: "", scopes: "" };
}

function fromSocial(c: SocialProviderView) {
  return {
    clientId: c.clientId,
    clientSecret: "",
    scopes: (c.scopes ?? []).join(" "),
  };
}
