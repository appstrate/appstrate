// SPDX-License-Identifier: Apache-2.0

/**
 * Modal that walks the user through connecting an OAuth model provider
 * (Codex / Claude Code).
 *
 * Why CLI, not browser:
 *   The public OAuth client_ids baked into the official CLIs only allowlist
 *   `http://localhost:PORT/...` redirect_uris. A platform-hosted callback
 *   is rejected at the provider's authorize step. So instead we delegate
 *   the loopback OAuth dance to the user's terminal via
 *   `appstrate connect <provider>`, then poll the platform for the new
 *   provider key to appear.
 *
 * Two stages:
 *   1. **ToS warning + label**: explicit notice that the subscription quota
 *      is shared org-wide, that the connection isn't covered by the
 *      provider's personal-tier ToS, and that Anthropic actively blocks
 *      third-party Pro/Max OAuth tokens server-side since 2026-01-09. The
 *      user must check the consent box AND name the connection before
 *      moving on.
 *   2. **CLI command + poller**: shows the exact `appstrate connect …`
 *      command to copy/paste, with a clipboard button + a spinner that
 *      polls `/api/model-provider-credentials` every 2.5s. When a new row matching
 *      this providerId appears, fires a success toast and closes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "./spinner";
import { useModelProviderCredentials } from "../hooks/use-model-provider-credentials";
import type { OrgModelProviderKeyInfo } from "@appstrate/shared-types";

interface Props {
  open: boolean;
  providerId: string;
  /** Pre-fill suggestion shown in the label input. */
  defaultLabel: string;
  onClose: () => void;
}

const SLUG_BY_PROVIDER_ID: Readonly<Record<string, "codex" | "claude">> = Object.freeze({
  codex: "codex",
  "claude-code": "claude",
});

/**
 * Build the exact CLI command the user must paste. Values that contain
 * shell metacharacters or spaces (like the label) are wrapped in single
 * quotes; embedded single quotes are escaped via the `'\''` idiom (close,
 * escape, reopen).
 */
function buildConnectCommand(slug: "codex" | "claude", label: string): string {
  const escapedLabel = label.replace(/'/g, "'\\''");
  return `bunx @appstrate/cli@latest connect ${slug} --label='${escapedLabel}'`;
}

export function OAuthModelProviderDialog({ open, providerId, defaultLabel, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const [stage, setStage] = useState<"tos" | "cli">("tos");
  const [label, setLabel] = useState(defaultLabel);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [copied, setCopied] = useState(false);

  const slug = SLUG_BY_PROVIDER_ID[providerId] ?? "codex";

  // Snapshot the set of provider-key ids that already existed at the moment
  // we entered the CLI stage. The poller treats any new id matching this
  // providerId as the connection completing. Without the snapshot we'd
  // false-positive on whatever was already on the org.
  const baselineRef = useRef<Set<string> | null>(null);

  // Poll model-provider-credentials every 2.5s while we're on the CLI stage. We
  // funnel the unstable `keysQuery.refetch` through a ref so the polling
  // effect's dependency array stays primitive — without this, the React-Query
  // hook returns a new object every render and the interval was being
  // shredded + recreated on every refetch, causing a tight request loop.
  const keysQuery = useModelProviderCredentials();
  const refetchRef = useRef(keysQuery.refetch);
  refetchRef.current = keysQuery.refetch;

  useEffect(() => {
    if (!open || stage !== "cli") return;
    const id = setInterval(() => {
      void refetchRef.current();
    }, 2500);
    return () => clearInterval(id);
  }, [open, stage]);

  // Fire success when a fresh row matching this providerId appears.
  useEffect(() => {
    if (!open || stage !== "cli") return;
    if (baselineRef.current === null) return;
    const baseline = baselineRef.current;
    const fresh = (keysQuery.data ?? []).find(
      (k: OrgModelProviderKeyInfo) => !baseline.has(k.id) && k.providerId === providerId,
    );
    if (fresh) {
      toast.success(t("providerKeys.oauth.callbackSuccess"));
      handleClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysQuery.data, open, stage, providerId]);

  const command = useMemo(
    () => buildConnectCommand(slug, label.trim() || defaultLabel),
    [slug, label, defaultLabel],
  );

  function reset() {
    setStage("tos");
    setLabel(defaultLabel);
    setTosAccepted(false);
    setCopied(false);
    baselineRef.current = null;
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleAdvanceToCli() {
    if (!tosAccepted || !label.trim()) return;
    baselineRef.current = new Set((keysQuery.data ?? []).map((k) => k.id));
    setStage("cli");
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("providerKeys.oauth.copyFailed"));
    }
  }

  if (stage === "tos") {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={t("providerKeys.oauth.tosTitle")}
        actions={
          <>
            <Button variant="ghost" onClick={handleClose}>
              {t("providerKeys.oauth.cancel")}
            </Button>
            <Button onClick={handleAdvanceToCli} disabled={!tosAccepted || !label.trim()}>
              {t("providerKeys.oauth.continue")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("providerKeys.oauth.tosWarningTitle")}</p>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5">
              <li>{t("providerKeys.oauth.tosBullet1")}</li>
              <li>{t("providerKeys.oauth.tosBullet2")}</li>
              <li>{t("providerKeys.oauth.tosBullet3")}</li>
              <li>{t("providerKeys.oauth.tosBullet4")}</li>
            </ul>
          </div>

          {slug === "claude" ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-xs">
              <p className="font-semibold">
                {t("providerKeys.oauth.tosAnthropicEnforcementTitle")}
              </p>
              <p className="mt-1">{t("providerKeys.oauth.tosAnthropicEnforcementBody")}</p>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              <p className="font-semibold">{t("providerKeys.oauth.tosOpenAiUnclearTitle")}</p>
              <p className="mt-1">{t("providerKeys.oauth.tosOpenAiUnclearBody")}</p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-label">{t("providerKeys.oauth.labelLabel")}</Label>
            <Input
              id="oauth-label"
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("providerKeys.oauth.labelPlaceholder")}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox
              id="oauth-tos-accept"
              checked={tosAccepted}
              onCheckedChange={(v) => setTosAccepted(v === true)}
              className="mt-0.5"
            />
            <span>{t("providerKeys.oauth.tosCheckboxLabel")}</span>
          </label>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("providerKeys.oauth.cliStageTitle")}
      actions={
        <Button variant="ghost" onClick={handleClose}>
          {t("providerKeys.oauth.close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>{t("providerKeys.oauth.cliInstructions")}</p>
        <div className="bg-muted relative flex items-center gap-2 rounded-md p-3 font-mono text-xs">
          <code className="flex-1 break-all whitespace-pre-wrap">{command}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            aria-label={t("providerKeys.oauth.copyCommand")}
            className="shrink-0"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="ml-1.5">
              {copied ? t("providerKeys.oauth.copied") : t("providerKeys.oauth.copy")}
            </span>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("providerKeys.oauth.cliHint")}</p>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner />
          <span>{t("providerKeys.oauth.cliWaiting")}</span>
        </div>
      </div>
    </Modal>
  );
}
