import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Modal } from "../components/modal";
import { Spinner } from "../components/spinner";
import { PageHeader } from "../components/page-header";
import { AppBreadcrumbSwitcher } from "../components/app-breadcrumb-switcher";
import { WebhookFormFields } from "../components/webhook-form-fields";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { toast } from "../hooks/use-toast";
import {
  useWebhook,
  useUpdateWebhook,
  useDeleteWebhook,
  useTestWebhook,
  useRotateWebhookSecret,
  useWebhookDeliveries,
} from "../hooks/use-webhooks";
import type { WebhookDelivery } from "../hooks/use-webhooks";

function formatRelativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("webhooks.lessThanMinute");
  if (minutes < 60) return t("webhooks.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("webhooks.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("webhooks.daysAgo", { count: days });
}

function deliveryStatusVariant(d: WebhookDelivery): "success" | "failed" | "pending" {
  if (d.status === "pending") return "pending";
  if (d.statusCode && d.statusCode >= 200 && d.statusCode < 300) return "success";
  return "failed";
}

function deliveryStatusLabel(d: WebhookDelivery): string {
  if (d.status === "pending") return "pending";
  if (d.statusCode) return `${d.statusCode}`;
  return d.status;
}

// --- Deliveries Tab ---

function DeliveriesTab({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: deliveries, isLoading, error } = useWebhookDeliveries(webhookId);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  if (!deliveries || deliveries.length === 0) {
    return <EmptyState message={t("settings:webhooks.noDeliveries")} icon={Send} compact />;
  }

  return (
    <div className="space-y-2">
      {deliveries.map((d) => {
        const variant = deliveryStatusVariant(d);
        return (
          <div key={d.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs text-muted-foreground truncate">{d.eventId}</span>
              <span className="font-mono text-sm">{d.eventType}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={variant}>{deliveryStatusLabel(d)}</Badge>
              {d.latency != null && <span>{d.latency}ms</span>}
              <span>{t("settings:webhooks.deliveryAttempt", { attempt: d.attempt })}</span>
              <span>{formatRelativeTime(d.createdAt, t)}</span>
            </div>
            {d.error && <p className="mt-1 text-xs text-destructive">{d.error}</p>}
          </div>
        );
      })}
    </div>
  );
}

// --- Settings Tab ---

function SettingsTab({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const { data: webhook } = useWebhook(webhookId);
  const updateMutation = useUpdateWebhook();
  const deleteMutation = useDeleteWebhook();
  const testMutation = useTestWebhook();
  const rotateMutation = useRotateWebhookSecret();

  const [selectedEvents, setSelectedEvents] = useState<string[]>(webhook?.events ?? []);
  const [payloadMode, setPayloadMode] = useState<"full" | "summary">(
    (webhook?.payloadMode as "full" | "summary") ?? "full",
  );
  const [active, setActive] = useState(webhook?.active ?? true);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotatedCopied, setRotatedCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  function handleSave() {
    updateMutation.mutate(
      {
        id: webhookId,
        data: { events: selectedEvents, payloadMode, active },
      },
      {
        onSuccess: () => {
          toast({ title: t("common:btn.save") });
        },
      },
    );
  }

  function handleTest() {
    testMutation.mutate(webhookId, {
      onSuccess: () => {
        toast({ title: t("settings:webhooks.testSuccess") });
      },
      onError: () => {
        toast({ title: t("settings:webhooks.testFailed"), variant: "destructive" });
      },
    });
  }

  function handleRotate() {
    rotateMutation.mutate(webhookId, {
      onSuccess: (result) => {
        setRotateOpen(false);
        setRotatedSecret(result.secret);
      },
    });
  }

  function handleRotatedCopy() {
    if (rotatedSecret) {
      navigator.clipboard.writeText(rotatedSecret);
      setRotatedCopied(true);
      setTimeout(() => setRotatedCopied(false), 2000);
    }
  }

  function handleDelete() {
    deleteMutation.mutate(webhookId, {
      onSuccess: () => {
        navigate("/webhooks");
      },
    });
  }

  if (!webhook) return null;

  return (
    <div className="space-y-6">
      {/* URL (read-only) */}
      <div className="space-y-2">
        <Label>{t("settings:webhooks.urlLabel")}</Label>
        <div className="font-mono text-sm bg-muted rounded px-3 py-2 break-all">{webhook.url}</div>
      </div>

      <WebhookFormFields
        selectedEvents={selectedEvents}
        onToggleEvent={toggleEvent}
        payloadMode={payloadMode}
        onPayloadModeChange={setPayloadMode}
        idPrefix="edit-"
      />

      {/* Active toggle */}
      <div className="flex items-center justify-between">
        <Label>{t("settings:webhooks.active")}</Label>
        <Switch checked={active} onCheckedChange={setActive} />
      </div>

      {/* Save */}
      <Button onClick={handleSave} disabled={updateMutation.isPending}>
        {updateMutation.isPending ? <Spinner /> : t("settings:webhooks.saveSettings")}
      </Button>

      {/* Secret section */}
      <div className="space-y-2 pt-4 border-t border-border">
        <Label>{t("settings:webhooks.secret")}</Label>
        <div className="font-mono text-sm bg-muted rounded px-3 py-2">whsec_****...</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRotateOpen(true)}
          disabled={rotateMutation.isPending}
        >
          {t("settings:webhooks.rotateSecret")}
        </Button>
      </div>

      {/* Rotate confirmation modal */}
      <Modal
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        title={t("settings:webhooks.rotateConfirmTitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => setRotateOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button onClick={handleRotate} disabled={rotateMutation.isPending}>
              {rotateMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("settings:webhooks.rotateConfirm")}</p>
      </Modal>

      {/* Rotated secret display modal */}
      {rotatedSecret && (
        <Modal
          open={!!rotatedSecret}
          onClose={() => {
            setRotatedSecret(null);
            setRotatedCopied(false);
          }}
          title={t("settings:webhooks.newSecret")}
        >
          <p className="text-sm text-warning bg-warning/10 rounded-md px-3 py-2">
            {t("settings:webhooks.secretWarning")}
          </p>
          <div className="flex items-center gap-2 mt-3 rounded-md border border-border bg-muted/50 px-3 py-2">
            <code className="flex-1 text-xs font-mono text-foreground break-all">
              {rotatedSecret}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-primary hover:underline shrink-0"
              onClick={handleRotatedCopy}
            >
              {rotatedCopied ? t("common:btn.copied") : t("common:btn.copy")}
            </Button>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
            <Button
              onClick={() => {
                setRotatedSecret(null);
                setRotatedCopied(false);
              }}
            >
              {t("common:btn.done")}
            </Button>
          </div>
        </Modal>
      )}

      {/* Test */}
      <div className="pt-4 border-t border-border">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={testMutation.isPending}>
          {testMutation.isPending ? <Spinner /> : t("settings:webhooks.sendTest")}
        </Button>
      </div>

      {/* Danger zone */}
      <div className="pt-4 border-t border-border space-y-3">
        <h3 className="text-sm font-semibold text-destructive">
          {t("settings:webhooks.dangerZone")}
        </h3>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteConfirmOpen(true)}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? <Spinner /> : t("settings:webhooks.deleteBtn")}
        </Button>
      </div>

      {/* Delete confirmation */}
      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title={t("settings:webhooks.deleteConfirm")}
        actions={
          <>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <Spinner /> : t("common:btn.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("settings:webhooks.deleteConfirm")}</p>
      </Modal>
    </div>
  );
}

// --- Main Detail Page ---

export function WebhookDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const { data: webhook, isLoading, error } = useWebhook(id!);

  const [tab, setTab] = useTabWithHash(["deliveries", "settings"] as const, "deliveries");

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!webhook) return <ErrorState />;

  return (
    <div>
      <PageHeader
        title={webhook.url}
        emoji="🪝"
        breadcrumbs={[
          { label: t("nav.appSection", { ns: "common" }), href: "/applications" },
          { label: "", node: <AppBreadcrumbSwitcher /> },
          { label: t("settings:webhooks.pageTitle"), href: "/webhooks" },
          { label: webhook.url },
        ]}
        actions={
          <Badge variant={webhook.active ? "success" : "secondary"}>
            {webhook.active ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
          </Badge>
        }
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-2">
          <TabsList>
            <TabsTrigger value="deliveries">{t("settings:webhooks.deliveries")}</TabsTrigger>
            <TabsTrigger value="settings">{t("settings:webhooks.settings")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {tab === "deliveries" && <DeliveriesTab webhookId={id!} />}
      {tab === "settings" && <SettingsTab webhookId={id!} />}
    </div>
  );
}
