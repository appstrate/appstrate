// SPDX-License-Identifier: Apache-2.0

/**
 * Storage module UI — exported from `@appstrate/module-storage/ui`.
 *
 * `StoragePage` is the storage feature, standalone: disks (native default +
 * connected cloud) + object inventory + upload/download/delete. It builds on
 * the shared `@appstrate/ui` design system (shadcn primitives + the shared
 * `Dropzone`) so it stays consistent with the rest of the platform and
 * reusable wherever storage is composed (workspace…). The host renders the
 * page title (PageHeader) and injects org/app scoping headers via `getHeaders`
 * — no cross-module dependency.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2, FileText, Lock, ExternalLink, Plus, HardDrive } from "lucide-react";
import { formatBytes } from "@appstrate/core/format";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@appstrate/ui/components/select";
import { Dropzone, type DropzoneUploadController } from "@appstrate/ui/components/dropzone";
import { ConnectDiskDialog, type ConnectIntegrationFn } from "./connect-disk-dialog.tsx";

export interface StoragePageProps {
  /** Org/app scoping headers supplied by the host shell (X-Org-Id, …). */
  getHeaders?: () => Record<string, string>;
  /** Native integration connect/upgrade (injected by the web shell). */
  connectIntegration?: ConnectIntegrationFn;
}

interface DiskDto {
  id: string;
  kind: "native" | "s3" | "google_drive" | "onedrive" | "dropbox";
  name: string;
  isDefault: boolean;
  enabled: boolean;
}

interface ObjectDto {
  id: string;
  diskId: string;
  name: string;
  mime: string | null;
  sizeBytes: number | null;
  visibility: "org" | "private";
}

const DISK_LABEL: Record<DiskDto["kind"], string> = {
  native: "Natif",
  s3: "S3",
  google_drive: "Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
};

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`border-border bg-card rounded-lg border ${className ?? ""}`}>
      {children}
    </section>
  );
}

function PanelHead({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-border flex items-center justify-between border-b px-4 py-3">
      <h3 className="text-sm font-semibold">
        {title}
        {count !== undefined && (
          <span className="text-muted-foreground ml-1.5 font-normal">({count})</span>
        )}
      </h3>
      {action}
    </div>
  );
}

export function StoragePage({ getHeaders, connectIntegration }: StoragePageProps) {
  const [disks, setDisks] = useState<DiskDto[]>([]);
  const [objects, setObjects] = useState<ObjectDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"org" | "private">("org");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;

  const callApi = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(path, {
        credentials: "include",
        ...init,
        headers: {
          ...(init?.body && !(init.body instanceof FormData)
            ? { "Content-Type": "application/json" }
            : {}),
          ...getHeaders?.(),
        },
      });
      if (!res.ok) {
        // Surface the RFC 9457 problem detail (e.g. "Google Drive OAuth is not
        // configured…") instead of a cryptic status code.
        let message = `Storage API ${res.status}`;
        try {
          const problem = (await res.json()) as { detail?: string; title?: string };
          if (problem.detail || problem.title) message = problem.detail ?? problem.title!;
        } catch {
          // non-JSON body — keep the status message
        }
        throw new Error(message);
      }
      return res.status === 204 ? null : res.json();
    },
    [getHeaders],
  );

  const refresh = useCallback(() => {
    Promise.all([callApi("/api/storage/disks"), callApi("/api/storage/objects")])
      .then(([d, o]) => {
        setDisks((d as { data: DiskDto[] }).data);
        setObjects((o as { data: ObjectDto[] }).data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Erreur inconnue"));
  }, [callApi]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const uploadObject = useCallback(
    (file: File, ctrl: DropzoneUploadController) =>
      new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/storage/objects");
        xhr.withCredentials = true;
        for (const [k, v] of Object.entries(getHeaders?.() ?? {})) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) ctrl.onProgress(e.loaded / e.total);
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Storage API ${xhr.status}`));
        xhr.onerror = () => reject(new Error("Erreur réseau"));
        ctrl.signal.addEventListener("abort", () => xhr.abort());
        const form = new FormData();
        form.append("file", file);
        form.append("visibility", visibilityRef.current);
        xhr.send(form);
      }),
    [getHeaders],
  );

  async function syncDisk(id: string) {
    setSyncing(id);
    try {
      await callApi(`/api/storage/disks/${id}/sync`, { method: "POST", body: "{}" });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setSyncing(null);
    }
  }

  async function openObject(o: ObjectDto) {
    // A raw <a href> wouldn't carry the X-Org-Id header the org-scoped route
    // needs — fetch the bytes with the scoping headers, then open the blob.
    try {
      const res = await fetch(`/api/storage/objects/${o.id}/content`, {
        credentials: "include",
        headers: { ...getHeaders?.() },
      });
      if (!res.ok) throw new Error(`Storage API ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function deleteObject(id: string) {
    try {
      await callApi(`/api/storage/objects/${id}`, { method: "DELETE" });
      setObjects((prev) => prev.filter((o) => o.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        {/* Left column — actions: upload + disks */}
        <div className="space-y-6 lg:col-span-1">
          <Panel className="space-y-3 p-4">
            <h3 className="text-sm font-semibold">Téléverser</h3>
            <div className="space-y-1.5">
              <Label htmlFor="storage-visibility" className="text-muted-foreground text-xs">
                Visibilité
              </Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as "org" | "private")}
              >
                <SelectTrigger id="storage-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org">Organisation</SelectItem>
                  <SelectItem value="private">Privé</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Dropzone
              upload={uploadObject}
              onUploaded={() => refresh()}
              label="Glissez des fichiers ici"
              hint="ou cliquez pour parcourir"
            />
          </Panel>

          <Panel>
            <PanelHead
              title="Disques"
              action={
                <Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
                  <Plus /> Connecter
                </Button>
              }
            />
            <ul className="divide-border divide-y">
              {disks.map((d) => (
                <li key={d.id} className="flex items-center gap-2 px-4 py-2.5">
                  <HardDrive className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate text-sm">{d.name}</span>
                  {d.isDefault && <Badge variant="secondary">défaut</Badge>}
                  <Badge variant="outline">{DISK_LABEL[d.kind]}</Badge>
                  {(d.kind === "s3" || d.kind === "google_drive") && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label="Synchroniser"
                      disabled={syncing === d.id}
                      onClick={() => void syncDisk(d.id)}
                    >
                      <RefreshCw className={syncing === d.id ? "animate-spin" : ""} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* Right column — the inventory table */}
        <div className="lg:col-span-2">
          <Panel>
            <PanelHead title="Objets" count={objects.length} />
            {objects.length === 0 ? (
              <p className="text-muted-foreground px-4 py-10 text-center text-sm">
                Aucun objet — téléversez un fichier pour démarrer.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nom</TableHead>
                    <TableHead className="w-24">Taille</TableHead>
                    <TableHead className="w-32">Visibilité</TableHead>
                    <TableHead className="w-16 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {objects.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => void openObject(o)}
                          className="hover:text-primary group flex items-center gap-2 text-left"
                        >
                          <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
                          <span className="truncate">{o.name}</span>
                          <ExternalLink
                            className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            aria-hidden
                          />
                        </button>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {o.sizeBytes !== null ? formatBytes(o.sizeBytes) : "—"}
                      </TableCell>
                      <TableCell>
                        {o.visibility === "private" ? (
                          <Badge variant="secondary" className="gap-1">
                            <Lock className="size-3" aria-hidden /> privé
                          </Badge>
                        ) : (
                          <Badge variant="outline">organisation</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Supprimer"
                          onClick={() => void deleteObject(o.id)}
                        >
                          <Trash2 className="text-muted-foreground hover:text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </div>
      </div>

      <ConnectDiskDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={refresh}
        callApi={callApi}
        connectIntegration={connectIntegration}
      />
    </div>
  );
}
