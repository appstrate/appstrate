// SPDX-License-Identifier: Apache-2.0

/**
 * The files of a package, for every type: what its AFPS bundle holds, then the
 * packages it depends on.
 *
 * One explorer, because a skill, an integration and a local MCP server are
 * AFPS bundles exactly as an agent is. The tree says so: `Bundle AFPS/` is the
 * archive itself (manifest.json, the type's main file, references/, scripts/),
 * `Dépendances/` what runs beside it (an agent's skills, the local server an
 * integration launches), shown only when there is something to show.
 *
 * It is also the ONE place a package's files are changed. For whoever may
 * write the package, on its draft, the tree carries the file gestures of the
 * shared package draft (`lib/package-file-drafts`): new file, import, rename,
 * delete, and a file's own Actions add Modifier (in a modal) and Remplacer.
 * Every gesture stays local until the save bar sends them all, with the stored
 * manifest and its lock version, in one package PUT. Dependencies and
 * published versions stay read-only.
 */
import { useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  FilePlus,
  Download,
  FolderOpen,
  GitCompareArrows,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  TextCursorInput,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import type { PackageType } from "@appstrate/core/validation";
import { formatBytes } from "@appstrate/core/format";
import { getErrorMessage } from "@appstrate/core/errors";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { client, $api, ApiError } from "../../api/client";
import { useModalParam } from "../../hooks/use-modal-param";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useOrgScope } from "../../hooks/use-org-scope";
import { usePackageDetail, usePackageVersions, useVersionDetail } from "../../hooks/use-packages";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import {
  isPinnedEntry,
  languageForPath,
  previewBlockReason,
  validateNewPath,
  NEW_PATH_ERROR_KEYS,
  type PackageFileEntry,
  type PackageFileWriteOperation,
  type TreeNode,
} from "../../lib/package-file-tree";
import {
  fileTextOperation,
  packageUpdateBody,
  projectDraftFiles,
  stageFileOperations,
  uploadedFileOperation,
  type DraftFile,
} from "../../lib/package-file-drafts";
import { packageFilesErrorKey, primaryDisplayFile } from "../../lib/package-files";
import { packageDetailPath, splitPackageRef } from "../../lib/package-paths";
import { ConfirmModal } from "../confirm-modal";
import { DiffTab } from "../diff-tab";
import { Modal } from "../modal";
import { ErrorState, LoadingState } from "../page-states";
import { ContentEditor } from "../package-editor/content-editor";
import { Spinner } from "../spinner";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { FilePathDialog } from "./file-path-dialog";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";
import { usePackageFile, usePackageFileDownload } from "./use-package-file";
import { AgentDetailPaneHeader, AgentDetailSplit } from "../agent-detail/agent-detail-split";

interface PackageReference {
  id: string;
  version: string | null;
  type: "skill" | "mcp-server";
}

interface VirtualFile {
  treeEntry: PackageFileEntry;
  /** What a read fetches: a renamed draft file is still read at its stored path. */
  sourceEntry: PackageFileEntry;
  /** A bundle file's path in the draft, which the file gestures address. */
  bundlePath?: string;
  packageId: string;
  source: "bundle" | "dependency";
  dependency?: PackageReference;
}

const BUNDLE_ROOT = "Bundle AFPS/";

type FileDialog = { kind: "create" } | { kind: "rename" | "delete"; path: string } | null;

/** The file gestures a bundle file offers, when its draft is being edited. */
interface FileGestures {
  canEdit: boolean;
  onEdit: () => void;
  onReplace: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  busy: boolean;
}

type SelectedItem =
  | { kind: "file"; file: VirtualFile }
  | { kind: "folder"; path: string; dependency?: PackageReference };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyReferences(
  manifest: Record<string, unknown> | undefined,
  key: "skills" | "mcp_servers",
  type: PackageReference["type"],
): PackageReference[] {
  if (!manifest || !isRecord(manifest.dependencies)) return [];
  const dependencies = manifest.dependencies[key];
  if (!isRecord(dependencies)) return [];
  return Object.entries(dependencies).map(([id, version]) => ({
    id,
    version: typeof version === "string" ? version : null,
    type,
  }));
}

/** The local MCP server an integration launches: its one runtime dependency. */
function localServerReference(manifest: Record<string, unknown> | undefined): PackageReference[] {
  const source = manifest?.source;
  if (!isRecord(source) || source.kind !== "local" || !isRecord(source.server)) return [];
  const { name, version } = source.server;
  if (typeof name !== "string") return [];
  return [{ id: name, version: typeof version === "string" ? version : null, type: "mcp-server" }];
}

function packageFolderName(packageId: string): string {
  return packageId.slice(packageId.lastIndexOf("/") + 1);
}

export function PackageFilesView({
  type,
  packageId,
  initialVersion,
  currentManifest,
  currentContent,
  editHref,
  initialPath,
  editable = false,
}: {
  type: PackageType;
  packageId: string;
  initialVersion?: string | undefined;
  /** The draft the page is editing, when it holds one; else the stored draft is read. */
  currentManifest?: Record<string, unknown> | undefined;
  currentContent?: string | null | undefined;
  /**
   * Where "Modifier" sends a bundle file the definition can edit (the prompt,
   * the manifest): its Définition section, modal open. Undefined for a file
   * nothing edits, or a reader who may not.
   */
  editHref?: (path: string) => string | undefined;
  /** A bundle file to open on, when a link sent the reader to it; else the main file. */
  initialPath?: string;
  /** The reader may write this package: its draft's files can be changed here. */
  editable?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const scope = useOrgScope();
  const queryClient = useQueryClient();
  const [selectedVersion, setSelectedVersion] = useState(initialVersion ?? "draft");
  const [compareVersion, setCompareVersion] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  const { data: versions } = usePackageVersions(type, packageId);
  const { data: storedDraft } = usePackageDetail(
    type,
    currentManifest || selectedVersion !== "draft" ? undefined : packageId,
  );
  const { data: selectedVersionDetail } = useVersionDetail(
    type,
    packageId,
    selectedVersion === "draft" ? undefined : selectedVersion,
  );
  const { data: compareVersionDetail } = useVersionDetail(
    type,
    packageId,
    compareVersion ?? undefined,
  );
  const { data: bundleIndex, error: bundleError } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: {
        path: splitPackageRef(packageId),
        ...(selectedVersion === "draft" ? {} : { query: { version: selectedVersion } }),
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );

  // ── The draft's file edits ──
  const editing = editable && selectedVersion === "draft";
  const { data: writableDraft } = usePackageDetail(type, editing ? packageId : undefined);
  const updatePackage = useUpdatePackage(type, packageId);
  const [operations, setOperations] = useState<PackageFileWriteOperation[]>([]);
  // The tree the first edit started from. A refetch cannot rebase staged edits;
  // the original lock version rejects the save if the package moved meanwhile.
  const [base, setBase] = useState<readonly PackageFileEntry[] | null>(null);
  const [dialog, setDialog] = useState<FileDialog>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editingFile = useModalParam("editFile");
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const dirty = operations.length > 0;
  const { blocker } = useUnsavedChanges(dirty);
  const limit = formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES);
  const bundleBase = base ?? bundleIndex?.entries;
  const bundleEntries: readonly DraftFile[] | undefined =
    editing && bundleBase ? projectDraftFiles(bundleBase, operations, type) : bundleIndex?.entries;

  const stage = (added: PackageFileWriteOperation[]) => {
    if (!bundleBase) return;
    try {
      const next = stageFileOperations(operations, added);
      projectDraftFiles(bundleBase, next, type);
      if (base === null) setBase(bundleBase);
      setOperations(next);
      setDialog(null);
      setSaveError(null);
      return true;
    } catch (error) {
      toast.error(t(packageFilesErrorKey(error) ?? "files.errorGeneric", { limit }));
      return false;
    }
  };
  const pickUpload = (target: string | null) => {
    replaceTarget.current = target;
    if (uploadRef.current) {
      uploadRef.current.multiple = target === null;
      uploadRef.current.click();
    }
  };
  const upload = async (picked: File[]) => {
    if (picked.some((file) => file.size > PACKAGE_FILE_INLINE_MAX_BYTES)) {
      toast.error(t("files.errorTooLarge", { limit }));
      return;
    }
    const target = replaceTarget.current;
    if (target === null) {
      // The whole selection is checked before anything is read or staged.
      const planned: PackageFileEntry[] = [...(bundleEntries ?? [])];
      for (const file of picked) {
        const rejection = validateNewPath(planned, file.name);
        if (rejection) {
          toast.error(
            t(
              rejection === "exists" || rejection === "conflict"
                ? "files.errorImportConflict"
                : NEW_PATH_ERROR_KEYS[rejection],
              { path: file.name },
            ),
          );
          return;
        }
        planned.push({ path: file.name, size: file.size, media_kind: "binary" });
      }
    }
    setBusy(true);
    try {
      stage(
        await Promise.all(picked.map((file) => uploadedFileOperation(target ?? file.name, file))),
      );
    } catch {
      toast.error(t("files.errorGeneric"));
    } finally {
      setBusy(false);
    }
  };
  const discardEdits = () => {
    setOperations([]);
    setBase(null);
    setSaveError(null);
  };
  const saveEdits = async () => {
    if (!writableDraft || !dirty) return;
    setBusy(true);
    setSaveError(null);
    try {
      await updatePackage.mutateAsync(
        packageUpdateBody({
          manifest: writableDraft.manifest ?? {},
          lock_version: writableDraft.lock_version,
          operations,
        }),
      );
      // Start again from what the server now holds, not from the staged tree.
      await queryClient.refetchQueries({ queryKey: ["get", "/api/packages/{scope}/{name}/files"] });
      discardEdits();
      toast.success(t("files.saved"));
    } catch (error) {
      const key = packageFilesErrorKey(error);
      setSaveError(key ? t(key, { limit }) : getErrorMessage(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const isPinned = (bundlePath: string) =>
    bundlePath === "manifest.json" || isPinnedEntry(type, bundlePath);

  const draftManifest = currentManifest ?? storedDraft?.manifest;
  const manifest = selectedVersion === "draft" ? draftManifest : selectedVersionDetail?.manifest;
  const skills = useMemo(() => dependencyReferences(manifest, "skills", "skill"), [manifest]);
  const mcpServers = useMemo(
    () => [
      ...dependencyReferences(manifest, "mcp_servers", "mcp-server"),
      ...localServerReference(manifest),
    ],
    [manifest],
  );
  const skillIndexes = useQueries({
    queries: skills.map((skill) => ({
      queryKey: [
        "agent-runtime-skill-files",
        scope.header["X-Org-Id"],
        scope.header["X-Space-Id"],
        skill.id,
      ],
      enabled: scope.enabled,
      queryFn: async () => {
        const { data, error } = await client.GET("/api/packages/{scope}/{name}/files", {
          params: { path: splitPackageRef(skill.id), header: scope.header },
        });
        if (error) throw error;
        return data;
      },
    })),
  });
  const localMcpIndexes = useQueries({
    queries: mcpServers.map((server) => ({
      queryKey: [
        "agent-runtime-local-mcp-files",
        scope.header["X-Org-Id"],
        scope.header["X-Space-Id"],
        server.id,
      ],
      enabled: scope.enabled,
      queryFn: async () => {
        const { data: detail, error: detailError } = await client.GET(
          "/api/packages/mcp-servers/{scope}/{name}",
          { params: { path: splitPackageRef(server.id), header: scope.header } },
        );
        if (detailError) throw detailError;
        if (!isRecord(detail.manifest)) return null;
        const serverManifest = detail.manifest.server;
        if (!isRecord(serverManifest) || typeof serverManifest.entry_point !== "string")
          return null;

        const { data: files, error: filesError } = await client.GET(
          "/api/packages/{scope}/{name}/files",
          { params: { path: splitPackageRef(server.id), header: scope.header } },
        );
        if (filesError) throw filesError;
        const paths = new Set(files.entries.map((entry) => entry.path));
        if (!paths.has("manifest.json") || !paths.has(serverManifest.entry_point)) return null;
        return files;
      },
    })),
  });

  const files = useMemo<VirtualFile[]>(() => {
    const bundle =
      bundleEntries?.map((entry: DraftFile) => ({
        source: "bundle" as const,
        packageId,
        bundlePath: entry.path,
        sourceEntry:
          entry.sourcePath && !entry.inline ? { ...entry, path: entry.sourcePath } : entry,
        treeEntry: { ...entry, path: `${BUNDLE_ROOT}${entry.path}` },
      })) ?? [];
    const runtimeSkills = skills.flatMap((skill, index) => {
      const entries = skillIndexes[index]?.data?.entries ?? [];
      return entries
        .filter((entry) => entry.path !== "manifest.json")
        .map((entry) => ({
          source: "dependency" as const,
          packageId: skill.id,
          dependency: skill,
          sourceEntry: entry,
          treeEntry: {
            ...entry,
            path: `Dépendances/Skills/${packageFolderName(skill.id)}/${entry.path}`,
          },
        }));
    });
    const localServers = mcpServers.flatMap((server, index) => {
      const entries = localMcpIndexes[index]?.data?.entries ?? [];
      return entries.map((entry) => ({
        source: "dependency" as const,
        packageId: server.id,
        dependency: server,
        sourceEntry: entry,
        treeEntry: {
          ...entry,
          path: `Dépendances/Serveurs MCP/${packageFolderName(server.id)}/${entry.path}`,
        },
      }));
    });
    return [...bundle, ...runtimeSkills, ...localServers];
  }, [bundleEntries, localMcpIndexes, mcpServers, packageId, skillIndexes, skills]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      normalizedQuery === ""
        ? files
        : files.filter((file) => file.treeEntry.path.toLocaleLowerCase().includes(normalizedQuery)),
    [files, normalizedQuery],
  );
  const fileByPath = useMemo(
    () => new Map(visibleFiles.map((file) => [file.treeEntry.path, file])),
    [visibleFiles],
  );
  const editedFile = editingFile.value
    ? files.find((file) => file.bundlePath === editingFile.value)
    : undefined;
  const mainFile = `Bundle AFPS/${initialPath ?? primaryDisplayFile(type).name}`;
  const defaultFile =
    visibleFiles.find((file) => file.treeEntry.path === mainFile) ?? visibleFiles[0];
  // A selected file is re-read from the current tree: an edit replaces its entry.
  const reselected =
    selected?.kind === "file"
      ? fileByPath.get(selected.file.treeEntry.path)
        ? { kind: "file" as const, file: fileByPath.get(selected.file.treeEntry.path)! }
        : null
      : selected;
  const activeSelection =
    reselected ?? (defaultFile ? { kind: "file" as const, file: defaultFile } : null);
  const selectedDependency =
    activeSelection?.kind === "file"
      ? activeSelection.file.dependency
      : activeSelection?.dependency;
  const { data: selectedDependencyDetail } = usePackageDetail(
    selectedDependency?.type ?? "skill",
    selectedDependency?.id,
  );
  const publishedVersions = versions?.filter((version) => !version.yanked) ?? [];
  const dependenciesLoading =
    skillIndexes.some((result) => result.isLoading) ||
    localMcpIndexes.some((result) => result.isLoading);
  const selectedVersionLabel =
    selectedVersion === "draft" ? t("agents:detail.files.currentDraft") : `v${selectedVersion}`;

  const selectPath = (path: string, node: TreeNode) => {
    if (node.kind === "file") {
      const file = fileByPath.get(path);
      if (file) setSelected({ kind: "file", file });
      return;
    }
    const dependency = [...skills, ...mcpServers].find((candidate) => {
      const group = candidate.type === "skill" ? "Skills" : "Serveurs MCP";
      const root = `Dépendances/${group}/${packageFolderName(candidate.id)}`;
      return path === root || path.startsWith(`${root}/`);
    });
    setSelected({ kind: "folder", path, ...(dependency ? { dependency } : {}) });
  };

  return (
    <div className="bg-card overflow-hidden" data-package-files>
      <AgentDetailSplit
        railClassName="flex min-h-[610px] flex-col text-left"
        rail={
          <>
            {/* The version comes first: only the draft is edited, so it decides
                what every control below can do. */}
            <AgentDetailPaneHeader>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-between"
                    aria-label={t("agents:detail.files.version")}
                    title={t("agents:detail.files.version")}
                    // Staged edits belong to the draft: finish them before reading a version.
                    disabled={dirty}
                  >
                    <span className="truncate">{selectedVersionLabel}</span>
                    <ChevronDown className="shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuItem
                    onSelect={() => {
                      setSelectedVersion("draft");
                      setSelected(null);
                    }}
                  >
                    <Check className={selectedVersion === "draft" ? "opacity-100" : "opacity-0"} />
                    {t("agents:detail.files.currentDraft")}
                  </DropdownMenuItem>
                  {publishedVersions.map((version) => (
                    <DropdownMenuItem
                      key={version.version}
                      onSelect={() => {
                        setSelectedVersion(version.version);
                        setSelected(null);
                      }}
                    >
                      <Check
                        className={
                          selectedVersion === version.version ? "opacity-100" : "opacity-0"
                        }
                      />
                      v{version.version}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <GitCompareArrows />
                      {t("agents:detail.files.compareWith")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {publishedVersions.length > 0 ? (
                        publishedVersions.map((version) => (
                          <DropdownMenuItem
                            key={version.version}
                            disabled={version.version === selectedVersion}
                            onSelect={() => setCompareVersion(version.version)}
                          >
                            v{version.version}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>
                          {t("agents:detail.files.noPublishedVersions")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </AgentDetailPaneHeader>
            <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
              <IconAction
                icon={Search}
                label={t("common:switcher.searchPlaceholder")}
                pressed={searchOpen}
                onClick={() => {
                  if (searchOpen) setQuery("");
                  setSearchOpen(!searchOpen);
                }}
              />
              {editing && (
                <>
                  <IconAction
                    icon={FilePlus}
                    label={t("files.newFile")}
                    disabled={busy}
                    onClick={() => setDialog({ kind: "create" })}
                  />
                  <IconAction
                    icon={Upload}
                    label={t("files.upload")}
                    disabled={busy}
                    onClick={() => pickUpload(null)}
                  />
                </>
              )}
            </div>
            {searchOpen && (
              <div className="border-border shrink-0 border-b p-2">
                <div className="relative w-full">
                  <Search
                    className="text-muted-foreground absolute top-2 left-2.5 size-4"
                    aria-hidden
                  />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSelected(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setQuery("");
                        setSearchOpen(false);
                      }
                    }}
                    placeholder={t("common:switcher.searchPlaceholder")}
                    className="h-8 pl-8"
                  />
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {bundleError ? (
                <ErrorState
                  message={t(
                    bundleError instanceof ApiError && bundleError.status === 404
                      ? "agents:files.errorMissingArtifact"
                      : "agents:files.errorLoad",
                  )}
                  compact
                />
              ) : !bundleIndex || dependenciesLoading ? (
                <LoadingState />
              ) : (
                <FileTree
                  entries={visibleFiles.map((file) => file.treeEntry)}
                  directories={[
                    "Bundle AFPS",
                    ...(skills.length > 0 ? ["Dépendances", "Dépendances/Skills"] : []),
                    ...(mcpServers.length > 0 ? ["Dépendances", "Dépendances/Serveurs MCP"] : []),
                  ]}
                  initialCollapsedPaths={["Dépendances/Skills", "Dépendances/Serveurs MCP"]}
                  selectedPath={
                    activeSelection?.kind === "file"
                      ? activeSelection.file.treeEntry.path
                      : (activeSelection?.path ?? null)
                  }
                  onSelect={(path) => {
                    const file = fileByPath.get(path);
                    if (file) setSelected({ kind: "file", file });
                  }}
                  onSelectNode={(node) => {
                    if (node.kind === "dir") selectPath(node.path, node);
                  }}
                  label={t("agents:files.treeLabel")}
                  controlsId="agent-file-preview"
                  className="h-full w-full p-1 text-left"
                  // Its new-file and import buttons live in the bar above.
                  showToolbar={false}
                  actions={
                    editing
                      ? {
                          onCreate: () => setDialog({ kind: "create" }),
                          onUpload: () => pickUpload(null),
                          onRename: (path) =>
                            path.startsWith(BUNDLE_ROOT) &&
                            setDialog({ kind: "rename", path: path.slice(BUNDLE_ROOT.length) }),
                          onDelete: (path) =>
                            path.startsWith(BUNDLE_ROOT) &&
                            setDialog({ kind: "delete", path: path.slice(BUNDLE_ROOT.length) }),
                          // Dependencies are other packages: never renamed or deleted here.
                          isPinned: (path) =>
                            !path.startsWith(BUNDLE_ROOT) ||
                            isPinned(path.slice(BUNDLE_ROOT.length)),
                          isBusy: busy,
                          labels: {
                            newFile: t("files.newFile"),
                            upload: t("files.upload"),
                            rename: t("files.rename"),
                            delete: t("files.delete"),
                          },
                        }
                      : undefined
                  }
                />
              )}
            </div>
          </>
        }
      >
        <div className="bg-background/30 min-w-0">
          {activeSelection?.kind === "file" ? (
            <div className="flex h-full min-w-0 flex-col">
              <SelectionHeader
                selection={activeSelection}
                resolvedVersion={selectedDependencyDetail?.version ?? null}
                // Only the draft is edited; a published version is read as it was.
                editHref={selectedVersion === "draft" ? editHref : undefined}
                gestures={
                  editing && activeSelection.file.bundlePath
                    ? {
                        canEdit:
                          activeSelection.file.bundlePath !== "manifest.json" &&
                          previewBlockReason(activeSelection.file.sourceEntry) === null,
                        onEdit: () => editingFile.open(activeSelection.file.bundlePath),
                        onReplace: () => pickUpload(activeSelection.file.bundlePath!),
                        onRename: isPinned(activeSelection.file.bundlePath)
                          ? undefined
                          : () =>
                              setDialog({ kind: "rename", path: activeSelection.file.bundlePath! }),
                        onDelete: isPinned(activeSelection.file.bundlePath)
                          ? undefined
                          : () =>
                              setDialog({ kind: "delete", path: activeSelection.file.bundlePath! }),
                        busy,
                      }
                    : undefined
                }
                fileVersion={
                  activeSelection.file.source === "bundle"
                    ? selectedVersion === "draft"
                      ? undefined
                      : selectedVersion
                    : (selectedDependencyDetail?.version ?? undefined)
                }
              />
              <FilePreview
                id="agent-file-preview"
                packageId={activeSelection.file.packageId}
                version={
                  activeSelection.file.source === "bundle"
                    ? selectedVersion === "draft"
                      ? undefined
                      : selectedVersion
                    : (selectedDependencyDetail?.version ?? undefined)
                }
                entry={activeSelection.file.sourceEntry}
                className="h-full flex-1 rounded-none border-0"
                hideHeader
              />
            </div>
          ) : activeSelection?.kind === "folder" ? (
            <div className="flex h-full min-w-0 flex-col">
              <SelectionHeader
                selection={activeSelection}
                resolvedVersion={selectedDependencyDetail?.version ?? null}
              />
              <FolderPreview path={activeSelection.path} dependency={activeSelection.dependency} />
            </div>
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center text-sm">
              {t("agents:detail.files.selectItem")}
            </div>
          )}
        </div>
      </AgentDetailSplit>

      {editing && dirty && (
        <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 flex-wrap items-center gap-3 border-t px-6 py-3">
          <span className="text-muted-foreground text-sm">
            {saveError ?? t("files.pendingCount", { count: operations.length })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" type="button" disabled={busy} onClick={discardEdits}>
              {t("editor.discardChanges")}
            </Button>
            <Button
              type="button"
              disabled={busy || !writableDraft}
              onClick={() => void saveEdits().catch(() => {})}
            >
              {busy ? <Spinner /> : t("btn.save", { ns: "common" })}
            </Button>
          </div>
        </div>
      )}
      <input
        ref={uploadRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          event.target.value = "";
          if (picked.length) void upload(picked);
        }}
      />
      {dialog?.kind === "create" && (
        <FilePathDialog
          title={t("files.newFile")}
          confirmLabel={t("btn.create", { ns: "common" })}
          initialPath=""
          entries={bundleEntries ?? []}
          onClose={() => setDialog(null)}
          onSubmit={(path) => {
            if (stage([fileTextOperation(path, "")])) {
              setSelected({
                kind: "file",
                file: { ...emptyBundleFile(packageId, path) },
              });
            }
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <FilePathDialog
          title={t("files.newName")}
          confirmLabel={t("files.rename")}
          initialPath={dialog.path}
          entries={(bundleEntries ?? []).filter((entry) => entry.path !== dialog.path)}
          onClose={() => setDialog(null)}
          onSubmit={(to) => {
            if (stage([{ op: "move", from: dialog.path, to }])) setSelected(null);
          }}
        />
      )}
      <ConfirmModal
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        title={t("files.delete")}
        description={t("files.deleteConfirm", {
          path: dialog?.kind === "delete" ? dialog.path : "",
        })}
        confirmLabel={t("files.delete")}
        isPending={busy}
        onConfirm={() => {
          if (dialog?.kind === "delete" && stage([{ op: "delete", path: dialog.path }])) {
            setSelected(null);
          }
        }}
      />
      {editing && editingFile.value !== null && (
        <Modal
          open
          onClose={editingFile.close}
          title={t("editor.editFile", { name: editingFile.value })}
          className="sm:max-w-5xl"
        >
          {/* The editor seeds Monaco once and owns its text afterwards, so it may
              only mount on the real entry: mounting on a placeholder (a deep
              link that lands before the tree has loaded) would open an empty
              file that never fills in. */}
          {editedFile ? (
            <FileTextEditor
              packageId={packageId}
              entry={editedFile.sourceEntry}
              path={editingFile.value}
              onApply={(text) => {
                if (stage([fileTextOperation(editingFile.value!, text)])) editingFile.close();
              }}
            />
          ) : bundleEntries ? (
            <ErrorState message={t("agents:files.errorLoad")} />
          ) : (
            <LoadingState />
          )}
        </Modal>
      )}
      <UnsavedChangesModal blocker={blocker} onSaveDraft={writableDraft ? saveEdits : undefined} />

      <Modal
        open={compareVersion !== null}
        onClose={() => setCompareVersion(null)}
        title={t("agents:detail.files.compareTitle", { version: compareVersion })}
        className="max-w-5xl"
      >
        {compareVersionDetail ? (
          <DiffTab
            type={type}
            latestVersion={compareVersionDetail}
            currentManifest={draftManifest}
            currentContent={
              currentContent ??
              (storedDraft && "content" in storedDraft ? storedDraft.content : null)
            }
          />
        ) : (
          <LoadingState />
        )}
      </Modal>
    </div>
  );
}
function SelectionHeader({
  selection,
  resolvedVersion,
  fileVersion,
  editHref,
  gestures,
}: {
  selection: SelectedItem;
  resolvedVersion: string | null;
  fileVersion?: string;
  editHref?: (path: string) => string | undefined;
  gestures?: FileGestures;
}) {
  const path = selection.kind === "file" ? selection.file.treeEntry.path : selection.path;
  const dependency = selection.kind === "file" ? selection.file.dependency : selection.dependency;
  const pathParts = path.split("/");

  return (
    <AgentDetailPaneHeader className="flex-wrap gap-3 text-left max-xl:h-auto max-xl:py-2">
      <div className="min-w-0 flex-1">
        {/* One truncating line: the folders read as context, the file as the subject. */}
        <p className="truncate font-mono text-xs" title={path}>
          {pathParts.length > 1 && (
            <span className="text-muted-foreground">{pathParts.slice(0, -1).join(" / ")} / </span>
          )}
          <span className="font-semibold">{pathParts[pathParts.length - 1]}</span>
        </p>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5 max-lg:w-full">
        {dependency && (
          <DependencyStatusCluster
            requestedVersion={dependency.version}
            resolvedVersion={resolvedVersion}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {dependency && (
            <DependencyVersion
              requestedVersion={dependency.version}
              resolvedVersion={resolvedVersion}
            />
          )}
          {selection.kind === "file" ? (
            <FileSelectionActions
              file={selection.file}
              version={fileVersion}
              gestures={gestures}
              editHref={
                selection.file.bundlePath ? editHref?.(selection.file.bundlePath) : undefined
              }
            />
          ) : dependency ? (
            <DependencySelectionActions dependency={dependency} />
          ) : null}
        </div>
      </div>
    </AgentDetailPaneHeader>
  );
}

function DependencyStatusCluster({
  requestedVersion,
  resolvedVersion,
}: {
  requestedVersion: string | null;
  resolvedVersion: string | null;
}) {
  const { t } = useTranslation("agents");
  const isResolved = Boolean(resolvedVersion ?? requestedVersion);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex items-center gap-1.5">
        {isResolved && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="cursor-help rounded-full focus-visible:outline-2">
                <Badge variant="secondary">{t("detail.files.status.resolved")}</Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {t("detail.files.tooltip.resolved")}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="cursor-help rounded-full focus-visible:outline-2">
              <Badge variant="outline">{t("detail.files.readOnly")}</Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {t("detail.files.tooltip.readOnly")}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function DependencyVersion({
  requestedVersion,
  resolvedVersion,
}: {
  requestedVersion: string | null;
  resolvedVersion: string | null;
}) {
  const { t } = useTranslation("agents");
  const requested = requestedVersion ?? resolvedVersion;
  const resolved = resolvedVersion ?? requestedVersion;
  const differs = Boolean(requested && resolved && requested !== resolved);
  const label = differs
    ? `${requested} → ${resolved}`
    : resolved
      ? resolved.startsWith("v")
        ? resolved
        : `v${resolved}`
      : "—";
  const tooltip = differs
    ? t("detail.files.tooltip.versionDifferent", { requested, resolved })
    : t("detail.files.tooltip.versionSame", { version: resolved ?? requested ?? "—" });

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground cursor-help rounded-sm font-mono text-xs whitespace-nowrap focus-visible:outline-2"
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FileSelectionActions({
  file,
  version,
  editHref,
  gestures,
}: {
  file: VirtualFile;
  version?: string;
  editHref?: string;
  gestures?: FileGestures;
}) {
  const { t } = useTranslation("agents");
  const download = usePackageFileDownload(file.packageId, version);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {t("detail.files.actions")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      {/* Closing must not hand focus back to the trigger: these items open a
          modal whose editor takes the focus, and Monaco loses its keyboard
          input when it is focused on mount and blurred right after. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        {gestures?.canEdit ? (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onEdit}>
            <Pencil />
            {t("btn.edit", { ns: "common" })}
          </DropdownMenuItem>
        ) : (
          editHref && (
            <DropdownMenuItem asChild>
              <Link to={editHref}>
                <Pencil />
                {t("btn.edit", { ns: "common" })}
              </Link>
            </DropdownMenuItem>
          )
        )}
        {gestures && file.bundlePath !== "manifest.json" && (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onReplace}>
            <RefreshCw />
            {t("files.replace")}
          </DropdownMenuItem>
        )}
        {gestures?.onRename && (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onRename}>
            <TextCursorInput />
            {t("files.rename")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void download(file.sourceEntry.path)}>
          <Download />
          {t("files.downloadFile")}
        </DropdownMenuItem>
        {gestures?.onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={gestures.busy}
              onSelect={gestures.onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {t("files.delete")}
            </DropdownMenuItem>
          </>
        )}
        {file.dependency && (
          <DropdownMenuItem asChild>
            <Link to={packageDetailPath(file.dependency.type, file.dependency.id)}>
              <Link2 />
              {t("detail.files.openDependency")}
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DependencySelectionActions({ dependency }: { dependency: PackageReference }) {
  const { t } = useTranslation("agents");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {t("detail.files.actions")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={packageDetailPath(dependency.type, dependency.id)}>
            <Link2 />
            {t("detail.files.openDependency")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderPreview({ path, dependency }: { path: string; dependency?: PackageReference }) {
  const { t } = useTranslation("agents");
  return (
    <div className="h-full p-6 text-left">
      <div className="flex items-center gap-3">
        <FolderOpen className="text-muted-foreground size-5" aria-hidden />
        <h3 className="font-mono text-sm font-semibold">{path}</h3>
      </div>
      {dependency && (
        <p className="text-muted-foreground mt-3 max-w-lg text-sm">
          {t("detail.files.selectItem")}
        </p>
      )}
    </div>
  );
}

/** A file just created in the draft, before the tree hands back its entry. */
function emptyBundleFile(packageId: string, path: string): VirtualFile {
  const entry: PackageFileEntry = { path, size: 0, media_kind: "text", inline: "" };
  return {
    source: "bundle",
    packageId,
    bundlePath: path,
    sourceEntry: entry,
    treeEntry: { ...entry, path: `${BUNDLE_ROOT}${path}` },
  };
}

/** A text file's editor in its modal: Appliquer stages it, the save bar saves it. */
function FileTextEditor({
  packageId,
  entry,
  path,
  onApply,
}: {
  packageId: string;
  entry: PackageFileEntry;
  path: string;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { text, isLoading, isError } = usePackageFile(packageId, undefined, entry, true);
  if (isError) return <ErrorState message={t("files.errorLoad")} />;
  if (isLoading || text === undefined) return <LoadingState />;
  return <FileTextEditorBody initial={text} path={path} onApply={onApply} />;
}

function FileTextEditorBody({
  initial,
  path,
  onApply,
}: {
  initial: string;
  path: string;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-3">
      <ContentEditor
        value={value}
        onChange={setValue}
        language={languageForPath(path)}
        // Fits a short window: the modal must never push Appliquer off screen.
        height="min(60vh, 560px)"
      />
      <div className="flex justify-end">
        <Button type="button" onClick={() => onApply(value)}>
          {t("editor.apply")}
        </Button>
      </div>
    </div>
  );
}

/** One of the tree bar's icon buttons: named for a screen reader, titled for a pointer. */
function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  pressed,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={pressed ? "secondary" : "ghost"}
      size="icon"
      className="size-8"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-4" />
    </Button>
  );
}
