// SPDX-License-Identifier: Apache-2.0

/**
 * The files of a package, for every type: what its AFPS bundle holds, then the
 * packages it depends on.
 *
 * One explorer, because a skill, an integration and a local MCP server are
 * AFPS bundles exactly as an agent is. The tree says so: its bundle folder is the
 * archive itself (manifest.json, the type's main file, references/, scripts/),
 * its dependencies folder what runs beside it (an agent's skills, the local server an
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
import { useMemo, useState } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { PackageType } from "@appstrate/core/validation";
import { asRecord, isPlainObject } from "@appstrate/core/safe-json";
import { formatBytes } from "../../lib/format-bytes";
import { matchesSearch } from "../../lib/strings";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { client, $api, ApiError } from "../../api/client";
import { useModalParam } from "../../hooks/use-modal-param";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useOrgScope } from "../../hooks/use-org-scope";
import { usePackageDetail, usePackageVersions, useVersionDetail } from "../../hooks/use-packages";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { useReportEditorDirty } from "../../hooks/use-editor-state";
import {
  isPinnedEntry,
  languageForPath,
  previewBlockReason,
  type PackageFileEntry,
  type PackageFileWriteOperation,
  type TreeNode,
} from "../../lib/package-file-tree";
import {
  fileTextOperation,
  packageUpdateBody,
  projectDraftFiles,
  type DraftFile,
} from "../../lib/package-file-drafts";
import { errorMessage } from "../../lib/mutation-error";
import { packageFilesErrorKey, primaryDisplayFile } from "../../lib/package-files";
import { packageDetailPath, splitPackageRef } from "../../lib/package-paths";
import { DiffTab } from "../diff-tab";
import { Modal } from "../modal";
import { ErrorState, LoadingState } from "../page-states";
import { ContentEditor } from "../package-editor/content-editor";
import { Spinner } from "../spinner";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";
import { usePackageFile, usePackageFileDownload } from "./use-package-file";
import { useStagedPackageFiles } from "./use-staged-package-files";
import { getSource } from "../integration-editor/utils";
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

// Stable tree keys; `useTreeFolderLabels` names them in the UI language.
const TREE_BUNDLE = "bundle";
const TREE_DEPENDENCIES = "dependencies";
const TREE_SKILLS = "dependencies/skills";
const TREE_MCP_SERVERS = "dependencies/mcp-servers";
const BUNDLE_ROOT = `${TREE_BUNDLE}/`;

function useTreeFolderLabels(): Readonly<Record<string, string>> {
  const { t } = useTranslation("agents");
  return useMemo(
    () => ({
      [TREE_BUNDLE]: t("files.treeBundle"),
      [TREE_DEPENDENCIES]: t("files.treeDependencies"),
      [TREE_SKILLS]: t("files.treeSkills"),
      [TREE_MCP_SERVERS]: t("files.treeMcpServers"),
    }),
    [t],
  );
}

/** A tree path as the user reads it: each keyed folder replaced by its label. */
function displayTreePath(path: string, labels: Readonly<Record<string, string>>): string {
  const parts = path.split("/");
  return parts.map((part, i) => labels[parts.slice(0, i + 1).join("/")] ?? part).join("/");
}

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

function dependencyReferences(
  manifest: Record<string, unknown> | undefined,
  key: "skills" | "mcp_servers",
  type: PackageReference["type"],
): PackageReference[] {
  return Object.entries(asRecord(asRecord(manifest?.dependencies)[key])).map(([id, version]) => ({
    id,
    version: typeof version === "string" ? version : null,
    type,
  }));
}

/** The local MCP server an integration launches: its one runtime dependency. */
function localServerReference(manifest: Record<string, unknown> | undefined): PackageReference[] {
  const source = getSource(manifest ?? {});
  return source.kind === "local" && source.serverName
    ? [{ id: source.serverName, version: source.serverVersion || null, type: "mcp-server" }]
    : [];
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
  const folderLabels = useTreeFolderLabels();
  const scope = useOrgScope();
  const queryClient = useQueryClient();
  const [selectedVersion, setSelectedVersion] = useState(initialVersion ?? "draft");
  const compareParam = useModalParam("compareFiles");
  const compareVersion = compareParam.value;
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
  // The draft the first edit started from. A refetch cannot rebase staged edits;
  // its ETag (sent as If-Match) rejects the save if the package moved meanwhile.
  const [base, setBase] = useState<{
    entries: readonly PackageFileEntry[];
    etag: string;
    manifest: Record<string, unknown>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editingFile = useModalParam("editFile");
  const dirty = operations.length > 0;
  const { blocker } = useUnsavedChanges(dirty);
  useReportEditorDirty(dirty);
  const bundleBase = base?.entries ?? bundleIndex?.data;
  const bundleEntries: readonly DraftFile[] | undefined =
    editing && bundleBase ? projectDraftFiles(bundleBase, operations, type) : bundleIndex?.data;
  const staged = useStagedPackageFiles({
    type,
    base: bundleBase,
    entries: bundleEntries ?? [],
    operations,
    onChange: (next) => {
      if (base === null && bundleBase && writableDraft) {
        setBase({
          entries: bundleBase,
          etag: writableDraft.etag ?? "",
          manifest: writableDraft.manifest ?? {},
        });
      }
      setOperations(next);
      setSaveError(null);
    },
    onSelect: (path) => setSelected({ kind: "file", file: emptyBundleFile(packageId, path) }),
    disabled: saving || !writableDraft,
  });
  const busy = staged.busy;

  const discardEdits = () => {
    setOperations([]);
    setBase(null);
    setSaveError(null);
  };
  const saveEdits = async () => {
    if (!base || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePackage.mutateAsync({
        etag: base.etag,
        body: packageUpdateBody({ manifest: base.manifest, operations }),
      });
      // Start again from what the server now holds, not from the staged tree.
      await queryClient.refetchQueries({ queryKey: ["get", "/api/packages/{scope}/{name}/files"] });
      discardEdits();
      toast.success(t("files.saved"));
    } catch (error) {
      const key = packageFilesErrorKey(error);
      setSaveError(
        key ? t(key, { limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES) }) : errorMessage(error),
      );
      throw error;
    } finally {
      setSaving(false);
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
        const serverManifest = asRecord(detail.manifest).server;
        if (!isPlainObject(serverManifest) || typeof serverManifest.entry_point !== "string")
          return null;

        const { data: files, error: filesError } = await client.GET(
          "/api/packages/{scope}/{name}/files",
          { params: { path: splitPackageRef(server.id), header: scope.header } },
        );
        if (filesError) throw filesError;
        const paths = new Set(files.data.map((entry) => entry.path));
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
      const entries = skillIndexes[index]?.data?.data ?? [];
      return entries
        .filter((entry) => entry.path !== "manifest.json")
        .map((entry) => ({
          source: "dependency" as const,
          packageId: skill.id,
          dependency: skill,
          sourceEntry: entry,
          treeEntry: {
            ...entry,
            path: `${TREE_SKILLS}/${packageFolderName(skill.id)}/${entry.path}`,
          },
        }));
    });
    const localServers = mcpServers.flatMap((server, index) => {
      const entries = localMcpIndexes[index]?.data?.data ?? [];
      return entries.map((entry) => ({
        source: "dependency" as const,
        packageId: server.id,
        dependency: server,
        sourceEntry: entry,
        treeEntry: {
          ...entry,
          path: `${TREE_MCP_SERVERS}/${packageFolderName(server.id)}/${entry.path}`,
        },
      }));
    });
    return [...bundle, ...runtimeSkills, ...localServers];
  }, [bundleEntries, localMcpIndexes, mcpServers, packageId, skillIndexes, skills]);

  const visibleFiles = useMemo(
    () =>
      files.filter((file) =>
        matchesSearch(query, [displayTreePath(file.treeEntry.path, folderLabels)]),
      ),
    [files, folderLabels, query],
  );
  const fileByPath = useMemo(
    () => new Map(visibleFiles.map((file) => [file.treeEntry.path, file])),
    [visibleFiles],
  );
  const editedFile = editingFile.value
    ? files.find((file) => file.bundlePath === editingFile.value)
    : undefined;
  const mainFile = `${BUNDLE_ROOT}${initialPath ?? primaryDisplayFile(type).name}`;
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
      const group = candidate.type === "skill" ? TREE_SKILLS : TREE_MCP_SERVERS;
      const root = `${group}/${packageFolderName(candidate.id)}`;
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
                            onSelect={() => compareParam.open(version.version)}
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
                    onClick={staged.openNewFile}
                  />
                  <IconAction
                    icon={Upload}
                    label={t("files.upload")}
                    disabled={busy}
                    onClick={() => staged.pickUpload(null)}
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
                    // Only this code says the version's archive is gone; a 404
                    // means the package or version itself does not resolve.
                    bundleError instanceof ApiError &&
                      bundleError.code === "version_artifact_unavailable"
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
                    TREE_BUNDLE,
                    ...(skills.length > 0 ? [TREE_DEPENDENCIES, TREE_SKILLS] : []),
                    ...(mcpServers.length > 0 ? [TREE_DEPENDENCIES, TREE_MCP_SERVERS] : []),
                  ]}
                  initialCollapsedPaths={[TREE_SKILLS, TREE_MCP_SERVERS]}
                  directoryLabels={folderLabels}
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
                          onCreate: staged.openNewFile,
                          onUpload: () => staged.pickUpload(null),
                          onRename: (path) =>
                            path.startsWith(BUNDLE_ROOT) &&
                            staged.openRename(path.slice(BUNDLE_ROOT.length)),
                          onDelete: (path) =>
                            path.startsWith(BUNDLE_ROOT) &&
                            staged.openDelete(path.slice(BUNDLE_ROOT.length)),
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
                        onReplace: () => staged.pickUpload(activeSelection.file.bundlePath!),
                        onRename: isPinned(activeSelection.file.bundlePath)
                          ? undefined
                          : () => staged.openRename(activeSelection.file.bundlePath!),
                        onDelete: isPinned(activeSelection.file.bundlePath)
                          ? undefined
                          : () => staged.openDelete(activeSelection.file.bundlePath!),
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
            <Button type="button" disabled={busy} onClick={() => void saveEdits().catch(() => {})}>
              {busy ? <Spinner /> : t("btn.save", { ns: "common" })}
            </Button>
          </div>
        </div>
      )}
      {staged.dialogs}
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
                if (staged.stage([fileTextOperation(editingFile.value!, text)]))
                  editingFile.close();
              }}
            />
          ) : bundleEntries ? (
            <ErrorState message={t("agents:files.errorLoad")} />
          ) : (
            <LoadingState />
          )}
        </Modal>
      )}
      <UnsavedChangesModal blocker={blocker} onSaveDraft={base ? saveEdits : undefined} />

      <Modal
        open={compareVersion !== null}
        onClose={compareParam.close}
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
  const folderLabels = useTreeFolderLabels();
  const path = displayTreePath(
    selection.kind === "file" ? selection.file.treeEntry.path : selection.path,
    folderLabels,
  );
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
  const folderLabels = useTreeFolderLabels();
  return (
    <div className="h-full p-6 text-left">
      <div className="flex items-center gap-3">
        <FolderOpen className="text-muted-foreground size-5" aria-hidden />
        <h3 className="font-mono text-sm font-semibold">{displayTreePath(path, folderLabels)}</h3>
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
