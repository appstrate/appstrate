// SPDX-License-Identifier: Apache-2.0

/**
 * The files of a package, for every type: what its AFPS bundle holds.
 *
 * One explorer, because a skill, an integration and a local MCP server are
 * AFPS bundles exactly as an agent is: the tree is the archive itself
 * (manifest.json, the type's main file, references/, scripts/).
 *
 * It is also the ONE place a package's files are changed. For whoever may
 * write the package, on its draft, the tree carries the file gestures of the
 * shared package draft (`lib/package-file-drafts`): new file, import, rename,
 * delete, and a file's own Actions add Modifier (in a modal) and Remplacer.
 * Every gesture stays local until the save bar sends them all
 * (`use-draft-file-edits`). Published versions stay read-only.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus, GitCompareArrows, Search, Upload } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { PackageType } from "@appstrate/core/validation";
import { OptionSelect } from "@/components/app-ui/option-select";
import { ApiError } from "../../api/client";
import { useUrlModal } from "../../hooks/use-url-modal";
import { usePackageVersions } from "../../hooks/use-packages";
import { matchesSearch } from "../../lib/strings";
import { isPinnedEntry, previewBlockReason } from "../../lib/package-file-tree";
import { fileTextOperation, type DraftFile } from "../../lib/package-file-drafts";
import { primaryDisplayFile } from "../../lib/package-files";
import { CompareWithDraftModal } from "../package-detail/compare-with-draft-modal";
import { AgentDetailPaneHeader, AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { Modal } from "../modal";
import { ErrorState } from "../page-states";
import { TextSkeleton } from "../loading-skeletons";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { FileActionsMenu } from "./file-actions";
import { FileTree } from "./file-tree";
import { PackageFileSource } from "./package-file-source";
import { PackageFileTextEditor } from "./package-file-text-editor";
import { SaveBar } from "../save-bar";
import { usePackageFileIndex } from "./use-package-file-index";
import { useDraftFileEdits } from "./use-draft-file-edits";

const PREVIEW_ID = "agent-file-preview";

/** What a read fetches: a renamed draft file is still read at its stored path. */
function sourceEntryOf(file: DraftFile): DraftFile {
  return file.sourcePath && !file.inline ? { ...file, path: file.sourcePath } : file;
}

export function PackageFilesView({
  type,
  packageId,
  initialVersion,
  editHref,
  initialPath,
  editable = false,
}: {
  type: PackageType;
  packageId: string;
  initialVersion?: string | undefined;
  /**
   * Where "Modifier" sends a file the definition can edit (the manifest): its
   * Définition section, modal open. Undefined for a file nothing edits, or a
   * reader who may not.
   */
  editHref?: (path: string) => string | undefined;
  /** A file to open on, when a link sent the reader to it; else the main file. */
  initialPath?: string;
  /** The reader may write this package: its draft's files can be changed here. */
  editable?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [selectedVersion, setSelectedVersion] = useState(initialVersion ?? "draft");
  const compareParam = useUrlModal("compareFiles");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const { data: versions } = usePackageVersions(type, packageId);
  const fileVersion = selectedVersion === "draft" ? undefined : selectedVersion;
  const { data: bundleIndex, error: bundleError } = usePackageFileIndex(packageId, fileVersion);

  const editing = editable && selectedVersion === "draft";
  const edits = useDraftFileEdits({
    type,
    packageId,
    index: bundleIndex?.data,
    editing,
    onSelect: setSelectedPath,
  });
  const { entries, staged, dirty } = edits;
  const busy = staged.busy;
  const isPinned = (path: string) => path === "manifest.json" || isPinnedEntry(type, path);

  const visibleFiles = (entries ?? []).filter((file) => matchesSearch(query, [file.path]));
  const mainFile = initialPath ?? primaryDisplayFile(type).name;
  const activeFile =
    visibleFiles.find((file) => file.path === selectedPath) ??
    visibleFiles.find((file) => file.path === mainFile) ??
    visibleFiles[0];
  const editedFile = editingPath ? entries?.find((file) => file.path === editingPath) : undefined;

  const publishedVersions = versions?.filter((version) => !version.yanked) ?? [];
  const versionOptions = [
    { value: "draft", label: t("agents:detail.files.currentDraft") },
    ...publishedVersions.map((version) => ({
      value: version.version,
      label: `v${version.version}`,
    })),
  ];
  if (!versionOptions.some((option) => option.value === selectedVersion)) {
    versionOptions.push({ value: selectedVersion, label: `v${selectedVersion}` });
  }

  const barActions = [
    {
      icon: Search,
      label: t("common:switcher.searchPlaceholder"),
      pressed: searchOpen,
      disabled: false,
      onClick: () => {
        if (searchOpen) setQuery("");
        setSearchOpen(!searchOpen);
      },
    },
    ...(editing
      ? [
          {
            icon: FilePlus,
            label: t("files.newFile"),
            disabled: busy,
            onClick: staged.openNewFile,
          },
          {
            icon: Upload,
            label: t("files.upload"),
            disabled: busy,
            onClick: () => staged.pickUpload(null),
          },
        ]
      : []),
  ];

  const activePath = activeFile?.path;
  const gestures =
    editing && activeFile && activePath
      ? {
          busy,
          onEdit:
            activePath !== "manifest.json" && previewBlockReason(sourceEntryOf(activeFile)) === null
              ? () => setEditingPath(activePath)
              : undefined,
          onReplace:
            activePath !== "manifest.json" ? () => staged.pickUpload(activePath) : undefined,
          onRename: isPinned(activePath) ? undefined : () => staged.openRename(activePath),
          onDelete: isPinned(activePath) ? undefined : () => staged.openDelete(activePath),
        }
      : undefined;

  return (
    <div className="bg-card overflow-hidden" data-package-files>
      <AgentDetailSplit
        railClassName="flex min-h-[610px] flex-col text-left"
        rail={
          <>
            {/* The version comes first: only the draft is edited, so it decides
                what every control below can do. */}
            <AgentDetailPaneHeader>
              <OptionSelect
                aria-label={t("agents:detail.files.version")}
                value={selectedVersion}
                options={versionOptions}
                onValueChange={(version) => {
                  setSelectedVersion(version);
                  setSelectedPath(null);
                }}
                // Staged edits belong to the draft: finish them before reading a version.
                disabled={dirty}
              />
            </AgentDetailPaneHeader>
            <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
              {barActions.map(({ icon: Icon, label, pressed, disabled, onClick }) => (
                <Button
                  key={label}
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
                  <Icon />
                </Button>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t("agents:detail.files.compareWith")}
                    title={t("agents:detail.files.compareWith")}
                  >
                    <GitCompareArrows />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
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
                </DropdownMenuContent>
              </DropdownMenu>
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
                      setSelectedPath(null);
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
              ) : !bundleIndex ? (
                <TextSkeleton lines={6} />
              ) : (
                <FileTree
                  entries={visibleFiles}
                  selectedPath={activePath ?? null}
                  onSelect={setSelectedPath}
                  label={t("agents:files.treeLabel")}
                  controlsId={PREVIEW_ID}
                  className="h-full min-h-0 w-full p-1 text-left"
                  // Its new-file and import buttons live in the bar above.
                  showToolbar={false}
                  actions={
                    editing
                      ? {
                          onCreate: staged.openNewFile,
                          onUpload: () => staged.pickUpload(null),
                          onRename: staged.openRename,
                          onDelete: staged.openDelete,
                          isPinned,
                          isBusy: busy,
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
          {activeFile ? (
            <div className="flex h-full min-w-0 flex-col">
              <AgentDetailPaneHeader className="flex-wrap gap-3 text-left max-xl:h-auto max-xl:py-2">
                <FilePath path={activeFile.path} />
                <div className="ml-auto shrink-0">
                  <FileActionsMenu
                    packageId={packageId}
                    version={fileVersion}
                    downloadPath={sourceEntryOf(activeFile).path}
                    // Only the draft is edited; a published version is read as it was.
                    editHref={selectedVersion === "draft" ? editHref?.(activeFile.path) : undefined}
                    gestures={gestures}
                  />
                </div>
              </AgentDetailPaneHeader>
              <PackageFileSource
                id={PREVIEW_ID}
                packageId={packageId}
                version={fileVersion}
                entry={sourceEntryOf(activeFile)}
                className="h-full flex-1 rounded-none border-0"
              />
            </div>
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center text-sm">
              {t("agents:detail.files.selectItem")}
            </div>
          )}
        </div>
      </AgentDetailSplit>

      {editing && dirty && (
        <SaveBar
          message={edits.saveError ?? t("files.pendingCount", { count: edits.operations.length })}
          pending={busy}
          onDiscard={edits.discard}
          onSave={() => void edits.save?.().catch(() => {})}
        />
      )}
      {staged.dialogs}
      {editing && editingPath !== null && (
        <Modal
          onClose={() => setEditingPath(null)}
          title={t("editor.editFile", { name: editingPath })}
          className="sm:max-w-5xl"
        >
          {/* The editor seeds Monaco once and owns its text afterwards, so it may
              only mount on the real entry: mounting on a placeholder would open
              an empty file that never fills in. */}
          {editedFile ? (
            <PackageFileTextEditor
              packageId={packageId}
              entry={sourceEntryOf(editedFile)}
              path={editingPath}
              onCommit={(text) => {
                if (staged.stage([fileTextOperation(editingPath, text)])) setEditingPath(null);
              }}
            />
          ) : entries ? (
            <ErrorState message={t("agents:files.errorLoad")} />
          ) : (
            <TextSkeleton lines={8} />
          )}
        </Modal>
      )}
      <UnsavedChangesModal blocker={edits.blocker} onSaveDraft={edits.save} />

      <CompareWithDraftModal type={type} packageId={packageId} compare={compareParam} />
    </div>
  );
}

/** One truncating line: the folders read as context, the file as the subject. */
function FilePath({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <p className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
      {parts.length > 1 && (
        <span className="text-muted-foreground">{parts.slice(0, -1).join(" / ")} / </span>
      )}
      <span className="font-semibold">{parts[parts.length - 1]}</span>
    </p>
  );
}
