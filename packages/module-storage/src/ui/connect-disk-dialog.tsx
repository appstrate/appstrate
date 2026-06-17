// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@appstrate/ui/components/dialog";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@appstrate/ui/components/select";

/** Scope storage needs to browse/read an existing Drive folder. */
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

/**
 * Host-provided connect/upgrade for a platform integration connection (the
 * native OAuth popup — `useIntegrationOAuthPopup` in the web shell). Injected
 * like `getHeaders` so the module stays host-agnostic and reusable by other
 * modules. On an upgrade (`connectionId` + `scopes`) the backend unions scopes,
 * never shrinking the grant.
 */
export type ConnectIntegrationFn = (opts: {
  packageId: string;
  authKey: string;
  scopes?: string[];
  connectionId?: string;
}) => Promise<void>;

export interface ConnectDiskDialogProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  /** Same scoped fetch helper the page uses (carries org/app headers). */
  callApi: (path: string, init?: RequestInit) => Promise<unknown>;
  /** Connect/upgrade an integration connection (re-consent for `drive.readonly`). */
  connectIntegration?: ConnectIntegrationFn;
}

type Kind = "google_drive" | "s3";

/** One of the caller's Google Drive integration connections (flattened). */
interface DriveConnection {
  connectionId: string;
  integrationId: string;
  applicationId: string;
  authKey: string;
  scopesGranted: string[];
  identity: string;
  appName: string;
}

// Shape of `GET /api/me/connections` (see @appstrate/shared-types).
interface MeConnGroup {
  source_id: string;
  display_name: string;
  connections: {
    connection_id: string;
    identity: string;
    auth_key: string;
    scopes_granted: string[];
    application: { id: string; name: string };
  }[];
}

/**
 * Connect a cloud disk — a Google Drive (reusing one of the caller's EXISTING
 * platform integration connections; no OAuth here) or an S3 bucket.
 */
export function ConnectDiskDialog({
  open,
  onClose,
  onConnected,
  callApi,
  connectIntegration,
}: ConnectDiskDialogProps) {
  const [kind, setKind] = useState<Kind>("google_drive");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  // Drive
  const [driveConns, setDriveConns] = useState<DriveConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [folderIds, setFolderIds] = useState("");

  // S3
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("");

  // Load the caller's Drive connections when the Drive tab is shown.
  const loadConnections = useCallback(async () => {
    try {
      const res = (await callApi("/api/me/connections")) as { data: MeConnGroup[] };
      const flat: DriveConnection[] = res.data
        .filter((g) => g.source_id.includes("google-drive"))
        .flatMap((g) =>
          g.connections.map((c) => ({
            connectionId: c.connection_id,
            integrationId: g.source_id,
            applicationId: c.application.id,
            authKey: c.auth_key,
            scopesGranted: c.scopes_granted,
            identity: c.identity,
            appName: c.application.name,
          })),
        );
      setDriveConns(flat);
      if (flat.length === 1) setConnectionId(flat[0]!.connectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }, [callApi]);

  useEffect(() => {
    if (open && kind === "google_drive" && driveConns === null) void loadConnections();
  }, [open, kind, driveConns, loadConnections]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (kind === "google_drive") {
        const conn = driveConns?.find((c) => c.connectionId === connectionId);
        const folders = folderIds
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!name.trim() || !conn || folders.length === 0) {
          throw new Error("Nom, connexion et au moins un ID de dossier requis");
        }
        await callApi("/api/storage/disks", {
          method: "POST",
          body: JSON.stringify({
            kind: "google_drive",
            name: name.trim(),
            config: {
              integration_id: conn.integrationId,
              connection_id: conn.connectionId,
              application_id: conn.applicationId,
              folder_ids: folders,
            },
          }),
        });
      } else {
        if (!name.trim() || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
          throw new Error("Nom, bucket, access key et secret requis");
        }
        await callApi("/api/storage/disks", {
          method: "POST",
          body: JSON.stringify({
            kind: "s3",
            name: name.trim(),
            config: {
              bucket: bucket.trim(),
              ...(region.trim() ? { region: region.trim() } : {}),
              ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
              ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
              access_key_id: accessKeyId.trim(),
              secret_access_key: secretAccessKey,
            },
          }),
        });
      }
      onConnected();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la connexion");
    } finally {
      setBusy(false);
    }
  }

  // Re-consent the picked connection to add `drive.readonly` in place (native
  // OAuth popup — the backend unions scopes, never shrinks the grant).
  async function upgradeReadonly() {
    const conn = driveConns?.find((c) => c.connectionId === connectionId);
    if (!conn || !connectIntegration) return;
    setBusy(true);
    setError(null);
    try {
      await connectIntegration({
        packageId: conn.integrationId,
        authKey: conn.authKey,
        scopes: [DRIVE_READONLY],
        connectionId: conn.connectionId,
      });
      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'autorisation");
    } finally {
      setBusy(false);
    }
  }

  const selectedConn = driveConns?.find((c) => c.connectionId === connectionId);
  const needsReadonly = !!selectedConn && !selectedConn.scopesGranted.includes(DRIVE_READONLY);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connecter un disque</DialogTitle>
          <DialogDescription>
            Un Google Drive (via une connexion d&apos;intégration existante) ou un bucket S3.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type de disque</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google_drive">Google Drive</SelectItem>
                <SelectItem value="s3">Bucket S3</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="disk-name">Nom</Label>
            <Input
              id="disk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mon Drive partagé"
            />
          </div>

          {kind === "google_drive" ? (
            <>
              <div className="space-y-1.5">
                <Label>Connexion</Label>
                {driveConns && driveConns.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucune connexion Google Drive. Connecte-la d&apos;abord dans{" "}
                    <a href="/integrations" className="underline">
                      Intégrations
                    </a>
                    , puis reviens ici.
                  </p>
                ) : (
                  <Select value={connectionId} onValueChange={setConnectionId}>
                    <SelectTrigger>
                      <SelectValue placeholder={driveConns ? "Choisir…" : "Chargement…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(driveConns ?? []).map((c) => (
                        <SelectItem key={c.connectionId} value={c.connectionId}>
                          {c.identity} · {c.appName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {needsReadonly && (
                <div className="border-border bg-muted/40 space-y-2 rounded-md border p-3">
                  <p className="text-muted-foreground text-xs">
                    Cette connexion n&apos;a pas l&apos;accès lecture (<code>drive.readonly</code>),
                    requis pour parcourir un dossier existant.
                  </p>
                  {connectIntegration ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void upgradeReadonly()}
                    >
                      Autoriser la lecture
                    </Button>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Autorise <code>drive.readonly</code> sur cette connexion dans Intégrations.
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="disk-folders">IDs de dossiers Drive</Label>
                <Input
                  id="disk-folders"
                  value={folderIds}
                  onChange={(e) => setFolderIds(e.target.value)}
                  placeholder="1AbC…, 2DeF… (séparés par des virgules)"
                />
                <p className="text-muted-foreground text-xs">
                  Obligatoire — seulement ces dossiers, jamais tout le Drive. La connexion doit
                  avoir le scope lecture (`drive.readonly`).
                </p>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="s3-bucket">Bucket</Label>
                <Input id="s3-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-region">Région</Label>
                <Input
                  id="s3-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-east-1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-prefix">Préfixe</Label>
                <Input
                  id="s3-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="(optionnel)"
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="s3-endpoint">Endpoint</Label>
                <Input
                  id="s3-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://… (MinIO/R2, optionnel)"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-akid">Access key ID</Label>
                <Input
                  id="s3-akid"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s3-secret">Secret access key</Label>
                <Input
                  id="s3-secret"
                  type="password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Connecter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
